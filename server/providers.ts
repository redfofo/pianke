import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { BrowseResult, Detail, Episode, MediaItem, PlaybackSource, Season, Source } from '../src/types.js';
import { safeRequest, type RequestOptions } from './provider-network.js';
import { backendUrl, ConfigError, requireBackend } from './config.js';
import { pageInfo } from './pagination.js';
import { parseWidgetMetadata, record, type WidgetMetadata, type WidgetModule } from './widget-metadata.js';
import { isKnownSource, knownSourceIds, registerSources, sourceTitle } from './source-registry.js';
import type { PosterArtwork } from './posters.js';

// Sources this project maps onto the Backend's REST API; every other source runs its upstream widget in the sandbox,
// so components added upstream work without a player release.
const backendApiSources = new Set(['hongguo', 'dsd', '51chigua', 'huangdou', 'huangju', 'yeguo']);
const runsWidget = (id: string) => !backendApiSources.has(id);
interface Widget { code: string; metadata: WidgetMetadata; expires: number; }
interface WorkerResult { value: unknown; logs: string[]; }
export interface ResolvedStream { url: string; headers: Record<string,string>; title: string; type?: string; }
const widgets = new Map<string, Widget>();
const widgetPending = new Map<string, Promise<Widget>>();
const children = new Set<ChildProcess>();
const requests = new Set<AbortController>();
let discovery: Promise<Map<string,string>> | undefined;
let discovered: Map<string,string> | undefined;
let stopped = false;
const configuredTimeout = Number(process.env.WIDGET_TIMEOUT_MS || 120000);
const widgetTimeout = Number.isFinite(configuredTimeout) ? Math.min(Math.max(configuredTimeout, 1000), 120000) : 120000;

function requireSource(id: string) {
  if (!isKnownSource(id)) throw new Error('未知内容源');
  if (stopped) throw new Error('内容源服务已关闭');
  requireBackend();
}
async function fetchText(url: string, options: RequestOptions = {}) {
  const controller = new AbortController();
  requests.add(controller);
  try { return await safeRequest(url, { ...options, signal: controller.signal, allowBackend: true }); }
  finally { requests.delete(controller); }
}
async function discoverWidgets(refresh = false): Promise<Map<string,string>> {
  requireBackend();
  if (discovery) return discovery;
  if (discovered && !refresh) return discovered;
  discovery = (async () => {
    const response = await fetchText(backendUrl + '/api/v1/components', { maxBytes: 2 * 1024 * 1024 });
    if (!response.ok) throw new Error(`读取上游来源失败: HTTP ${response.status}`);
    const payload = record(JSON.parse(response.data));
    if (!Array.isArray(payload.components)) throw new Error('上游组件列表格式无效');
    const installed = new Map<string, boolean>();
    const components: { id: string; title: unknown }[] = [];
    for (const value of payload.components) {
      const entry = record(value);
      if (typeof entry.id !== 'string' || typeof entry.enabled !== 'boolean') throw new Error('上游组件状态格式无效');
      installed.set(entry.id, entry.enabled);
      components.push({ id: entry.id, title: entry.title });
    }
    registerSources(components);
    const urls = new Map<string,string>();
    for (const id of knownSourceIds()) {
      if (installed.get(id)) urls.set(id, backendUrl + `/widgets/${id}.js`);
      else widgets.delete(id);
    }
    discovered = urls;
    return urls;
  })();
  try { return await discovery; } finally { discovery = undefined; }
}
async function widget(id: string): Promise<Widget> {
  requireSource(id);
  const urls = await discoverWidgets();
  const url = urls.get(id);
  if (!url) throw new Error(`上游未启用 ${sourceTitle(id)} 组件`);
  const cached = widgets.get(id);
  if (cached && cached.expires > Date.now()) return cached;
  const pending = widgetPending.get(id);
  if (pending) return pending;
  const task = (async () => {
    const response = await fetchText(url, { maxBytes: 2 * 1024 * 1024 });
    if (!response.ok) throw new Error(`下载组件失败: HTTP ${response.status}`);
    const value = { code: response.data, metadata: parseWidgetMetadata(response.data), expires: Date.now() + 15 * 60 * 1000 };
    widgets.set(id, value);
    return value;
  })();
  widgetPending.set(id, task);
  try { return await task; } finally { widgetPending.delete(id); }
}
/** Registers components newly installed upstream; an unreachable upstream leaves the known sources unchanged. */
export async function refreshSourceRegistry(): Promise<void> {
  try { await discoverWidgets(true); } catch { /* Callers report the known sources; listing reports upstream errors. */ }
}
/** `allowed` is a predicate so that sources registered by this very discovery can pass (e.g. for administrators). */
export async function listSources(allowed: readonly string[] | ((id: string) => boolean)): Promise<Source[]> {
  if (Array.isArray(allowed) && !allowed.length) return [];
  const permitted = typeof allowed === 'function' ? allowed : (id: string) => allowed.includes(id);
  const urls = await discoverWidgets(true);
  return Promise.all(Array.from(urls.keys()).filter(permitted).map(async (id) => {
    const title = sourceTitle(id);
    try {
      const { metadata } = await widget(id);
      return { id, title: metadata.title, description: metadata.description || '', version: metadata.version || '', icon: metadata.icon || '', capabilities: ['browser','search','detail','playback'], modules: metadata.modules.filter(module => !/history/i.test(module.functionName)).map(({ functionName: _functionName, ...module }) => module) } satisfies Source;
    } catch (error) {
      return { id, title, description: '', version: '', icon: '', capabilities: [], modules: [], error: error instanceof Error ? error.message : String(error) } satisfies Source;
    }
  }));
}
function parameters(module: WidgetModule, input: Record<string,string>) {
  const values: Record<string,string> = Object.create(null);
  for (const param of module.params) {
    const value = param.type === 'constant' ? param.value || param.defaultValue || '' : input[param.name] ?? param.value ?? param.defaultValue ?? param.enumOptions?.[0]?.value ?? '';
    if (value.length > 1000) throw new Error(`参数过长: ${param.title}`);
    if (param.enumOptions?.length && !param.enumOptions.some(option => option.value === value)) throw new Error(`参数选项无效: ${param.title}`);
    values[param.name] = value;
  }
  const page = Number(input.page || values.page || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new Error('页码无效');
  values.page = String(page);
  return values;
}
async function backendJson(url: string) {
  const response = await fetchText(url, { timeout: 45000 });
  let payload: unknown;
  try { payload = JSON.parse(response.data); } catch { throw new Error(`Backend 返回非 JSON 内容 (HTTP ${response.status})`); }
  const outer = record(payload);
  if (!response.ok || outer.error || outer.ok === false || outer.success === false) throw new Error(String(outer.error || outer.message || outer.detail || `Backend HTTP ${response.status}`).slice(0, 1000));
  return outer.data !== undefined ? record(outer.data) : outer;
}
function detailLink(id: string, input: string) {
  if (!input || input.length > 8000) throw new Error('详情地址无效');
  if (id === 'huangguo') {
    const url = new URL(input, 'https://huangguoai.com');
    if (!/^\/(?:detail|video)\/\d+\/?$/.test(url.pathname) || !['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('不允许读取非黄果详情地址');
    // Never request a user-selected host; the widget discovers its own active routes.
    return 'https://huangguoai.com' + url.pathname;
  }
  if (id === 'missav') {
    const url = new URL(input, 'https://missav.invalid');
    if (!/^\/(?:cn|dm\d+)\/[a-z0-9-]+\/?$/i.test(url.pathname) || !['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('不允许读取非 MissAV 详情地址');
    return url.pathname + (url.searchParams.get('builtInChineseSubtitle') === '1' ? '?builtInChineseSubtitle=1' : '');
  }
  if (runsWidget(id)) {
    // Links of upstream-added widgets are opaque to this project and only ever reach the sandboxed widget, whose
    // network access is limited to public hosts and its own Backend namespace (see executeWidget).
    if (/[\x00-\x1f\x7f]/.test(input)) throw new Error('详情地址无效');
    if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      const url = new URL(input);
      if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('详情地址无效');
      if (url.origin === new URL(backendUrl).origin && !url.pathname.startsWith(`/api/v1/providers/${id}/`) && !url.pathname.startsWith(`/api/v1/${id}/`)) throw new Error('详情地址必须属于当前内容源');
    }
    return input;
  }
  const url = new URL(input, backendUrl);
  const expected = new URL(backendUrl);
  const prefix = expected.pathname.replace(/\/$/, '') + `/api/v1/providers/${id}/items/`;
  if (url.origin !== expected.origin || !url.pathname.startsWith(prefix) || !url.pathname.slice(prefix.length) || url.pathname.slice(prefix.length).includes('/') || url.search || url.hash || url.username || url.password) throw new Error('详情地址必须属于当前 Backend 和内容源');
  const itemId = decodeURIComponent(url.pathname.slice(prefix.length));
  if (/[\x00-\x1f\\/]/.test(itemId) || itemId === '.' || itemId === '..') throw new Error('内容标识无效');
  return backendUrl + `/api/v1/providers/${id}/items/` + encodeURIComponent(itemId);
}
interface RememberedArtwork extends PosterArtwork { backdropUrl?: string; }
const artworkCache = new Map<string, RememberedArtwork>();
const artworkPending = new Map<string, Promise<PosterArtwork>>();
let artworkGeneration = 0;
function artworkKey(id: string, input: string): string {
  const link = detailLink(id, input);
  const url = new URL(link, backendUrl);
  // Mirror/presentation paths can differ for the same video, but video suffixes remain significant.
  const identity = id === 'missav' ? url.pathname.split('/').filter(Boolean).at(-1)!.toLowerCase()
    : id === 'huangguo' ? url.pathname.split('/').filter(Boolean).at(-1)! : link;
  return JSON.stringify([backendUrl, id, identity]);
}
function artworkUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8000) return '';
  try {
    const url = new URL(value, backendUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function artworkFromRow(row: Record<string, unknown>): RememberedArtwork {
  const backdropUrl = artworkUrl(row.backdropPath || row.backdropUrl);
  const candidates = [row.posterUrl, row.posterPath, row.poster, row.cover, row.fallbackCoverPath, backdropUrl].map(artworkUrl).filter(Boolean);
  const [url = '', ...fallbackUrls] = [...new Set(candidates)];
  // Video cookies/headers are not artwork credentials.
  const headers = customHeaders(row.posterHeaders || row.artworkHeaders || row.coverHeaders);
  return { url, ...(fallbackUrls.length ? { fallbackUrls } : {}), ...(Object.keys(headers).length ? { headers } : {}), ...(backdropUrl ? { backdropUrl } : {}) };
}
function rememberArtwork(id: string, link: string, artwork: RememberedArtwork, merge = false): RememberedArtwork {
  const key = artworkKey(id, link);
  const previous = artworkCache.get(key);
  if (!artwork.url) return previous || artwork;
  if (merge && previous) {
    const fallbackUrls = [...new Set([...(artwork.fallbackUrls || []), previous.url, ...(previous.fallbackUrls || [])])].filter(url => url !== artwork.url).slice(0, 8);
    artwork = { ...previous, ...artwork, fallbackUrls };
  }
  artworkCache.delete(key);
  if (artworkCache.size >= 4000) artworkCache.delete(artworkCache.keys().next().value!);
  artworkCache.set(key, artwork);
  return artwork;
}
export function peekPosterArtwork(sourceId: string, link: string): PosterArtwork | undefined {
  requireSource(sourceId);
  return artworkCache.get(artworkKey(sourceId, link));
}
function mediaItem(id: string, value: unknown, direct: boolean): MediaItem {
  const row = record(value);
  const title = String(row.title || row.name || '');
  const link = direct ? detailLink(id, String(row.detailUrl || row.link || row.id || '')) : row.detailUrl ? detailLink(id, String(row.detailUrl)) : backendUrl + `/api/v1/providers/${id}/items/` + encodeURIComponent(String(row.id || ''));
  if (!title || (!direct && !row.id && !row.detailUrl)) throw new Error('上游列表包含无效内容');
  const artwork = rememberArtwork(id, link, artworkFromRow(row));
  return { id: `${id}:${createHash('sha256').update(link).digest('hex').slice(0,20)}`, title, posterUrl: artwork.url, description: String(row.description || ''), remark: String(row.remark || row.durationText || ''), link, mediaType: String(row.mediaType || 'tv'), sourceId: id };
}
function browseResult(id: string, payload: unknown, page: number, direct: boolean, logs: string[] = []): BrowseResult {
  const data = Array.isArray(payload) ? undefined : record(payload);
  const rows: unknown = data ? data.items : payload;
  if (!Array.isArray(rows)) throw new Error('上游没有返回内容列表');
  const items: MediaItem[] = [];
  const errors: string[] = [];
  for (const value of rows) {
    const row = record(value);
    if (/(?:error|diagnostic|notice|placeholder)/i.test(String(row.type || '')) || /(?:请求失败|访问失败|访问受限|暂时无法|线路不可用|没有可用线路|网络错误)/.test(String(row.title || ''))) { errors.push(String(row.description || row.title)); continue; }
    try { items.push(mediaItem(id, row, direct)); } catch (error) { errors.push(String(row.description || (error instanceof Error ? error.message : error))); }
  }
  if (!items.length && errors.length) throw new Error(errors.join('; ').slice(0, 1500));
  if (!items.length && direct && logs.some(line => /失败|error|blocked|timeout|超时|风控/i.test(line))) throw new Error('组件未返回内容: ' + logs.slice(-4).join('; ').slice(0, 1500));
  return { items, page, ...pageInfo(data, page, items.length) };
}
// Widget processes are capped; callers queue for a slot (background catalog sync shares it with users).
const widgetSlots = 4;
let widgetsRunning = 0;
const widgetWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
async function acquireWidgetSlot(): Promise<void> {
  if (stopped) throw new Error('内容源服务已关闭');
  if (widgetsRunning < widgetSlots) { widgetsRunning++; return; }
  const gate = Promise.withResolvers<void>();
  const waiter = { resolve: gate.resolve, reject: gate.reject };
  widgetWaiters.push(waiter);
  const timer = setTimeout(() => {
    widgetWaiters.splice(widgetWaiters.indexOf(waiter), 1);
    gate.reject(new Error('直连组件繁忙，请稍后重试'));
  }, widgetTimeout);
  try { await gate.promise; } finally { clearTimeout(timer); }
}
function releaseWidgetSlot(): void {
  // A waiter inherits the released slot, so the running count only drops when nobody is queued.
  const next = widgetWaiters.shift();
  if (next) next.resolve(); else widgetsRunning--;
}
async function executeWidget(id: string, functionName: string, argument: unknown): Promise<WorkerResult> {
  const source = await widget(id);
  await acquireWidgetSlot();
  try { return await runWidget(id, source, functionName, argument); }
  finally { releaseWidgetSlot(); }
}
function runWidget(id: string, source: Widget, functionName: string, argument: unknown): Promise<WorkerResult> {
  const workerPath = resolve('dist/server/widget-worker.js');
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<WorkerResult>();
    const child = fork(workerPath, [], { execArgv: ['--permission', `--allow-fs-read=${workerPath}`, '--no-addons', '--disable-proto=throw', '--max-old-space-size=192'], env: { NODE_ENV: 'production', LANG: 'C.UTF-8' }, stdio: ['ignore','ignore','pipe','ipc'], serialization: 'json' });
    children.add(child);
    const active = new Map<number, AbortController>();
    const queue: { resolve: () => void; reject: (error: Error) => void }[] = [];
    let networkRunning = 0;
    let count = 0;
    let settled = false;
    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2000); });
    const finish = (error?: Error, result?: WorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const controller of active.values()) controller.abort();
      active.clear();
      for (const entry of queue.splice(0)) entry.reject(new Error('组件执行已结束'));
      children.delete(child);
      child.kill('SIGKILL');
      if (error) reject(error); else resolveResult(result!);
    };
    const timer = setTimeout(() => finish(new Error(`${sourceTitle(id)} 组件执行超时（${widgetTimeout / 1000} 秒）；上游线路可能不可达`)), widgetTimeout);
    child.on('error', error => finish(error));
    child.on('exit', (code, signal) => finish(new Error(`组件进程退出 (${code ?? signal}): ${stderr.slice(-1000)}`)));
    child.on('message', async (input: unknown) => {
      if (settled) return;
      try {
        const message = record(input);
        if (message.kind === 'result') {
          if (message.error) finish(new Error(String(message.error)));
          else finish(undefined, { value: message.result, logs: Array.isArray(message.logs) ? message.logs.map(String) : [] });
          return;
        }
        const requestId = Number(message.id);
        if (message.kind === 'http-cancel') { active.get(requestId)?.abort(); return; }
        if (message.kind !== 'http') throw new Error('组件 IPC 消息无效');
        if (++count > 1500 || active.size >= 500) throw new Error('组件网络请求超过限制');
        const target = new URL(String(message.url));
        const opts = record(message.options);
        // The configured Backend is the only private origin; direct widgets can call only their own API namespace.
        if (target.origin === new URL(backendUrl).origin && !target.pathname.startsWith(`/api/v1/${id}/`) && !target.pathname.startsWith(`/api/v1/providers/${id}/`) && target.pathname !== `/api/v1/discovery/sites/${id}/routes`) {
          // Fail only this request: widgets may probe optional Backend helpers and continue without them.
          if (child.connected) child.send({ kind: 'http-result', id: requestId, error: '组件不允许访问此 Backend 路径' });
          return;
        }
        const headers: Record<string,string> = {};
        if (opts.headers) for (const [name,value] of Object.entries(record(opts.headers))) if (typeof value === 'string' && !['host','connection','content-length','transfer-encoding'].includes(name.toLowerCase())) headers[name] = value;
        const controller = new AbortController();
        active.set(requestId, controller);
        let acquired = false;
        try {
          if (networkRunning < 12) networkRunning++;
          else {
            const gate = Promise.withResolvers<void>();
            queue.push(gate);
            await gate.promise;
          }
          acquired = true;
          const response = await safeRequest(target.href, { method: String(opts.method || 'GET'), body: typeof opts.body === 'string' ? opts.body : undefined, headers, timeout: Number(opts.timeout) || 15000, redirects: opts.redirects === 0 ? 0 : 5, allowBackend: true, signal: controller.signal });
          if (child.connected) child.send({ kind: 'http-result', id: requestId, response });
        } catch (error) {
          if (child.connected) child.send({ kind: 'http-result', id: requestId, error: error instanceof Error ? error.message : String(error) });
        } finally {
          active.delete(requestId);
          if (acquired) {
            const next = queue.shift();
            if (next) next.resolve(); else networkRunning--;
          }
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    child.send({ kind: 'start', code: source.code, functionName, argument, backendUrl });
  return promise;
}
// Paging back and forth repeats identical list requests, and a widget page can take tens of seconds to load.
const listCache = new Map<string, { value: BrowseResult; expires: number }>();
const listPending = new Map<string, Promise<BrowseResult>>();
const listCacheTtl = 3 * 60 * 1000;
let listGeneration = 0;
async function cachedList(key: string, fresh: boolean, load: () => Promise<BrowseResult>): Promise<BrowseResult> {
  const entry = listCache.get(key);
  if (!fresh && entry && entry.expires > Date.now()) return entry.value;
  listCache.delete(key);
  const pending = listPending.get(key);
  if (pending) return pending;
  const generation = listGeneration;
  const task = load().then(value => {
    if (generation === listGeneration) {
      if (listCache.size >= 200) listCache.delete(listCache.keys().next().value!);
      listCache.set(key, { value, expires: Date.now() + listCacheTtl });
    }
    return value;
  });
  listPending.set(key, task);
  try { return await task; } finally { if (listPending.get(key) === task) listPending.delete(key); }
}
export async function browseSource(id: string, moduleId: string | undefined, params: Record<string,string>, fresh = false): Promise<BrowseResult> {
  const { metadata } = await widget(id);
  const module = moduleId ? metadata.modules.find(entry => entry.id === moduleId) : metadata.modules.find(entry => !/search|history/i.test(entry.functionName));
  if (!module) throw new Error('浏览分类不存在');
  if (/history/i.test(module.functionName)) throw new ConfigError('请在观看记录中查看当前账号的播放历史', 403);
  const values = parameters(module, params);
  return cachedList(JSON.stringify(['browse', id, module.id, values]), fresh, () => loadBrowse(id, module, values));
}
async function loadBrowse(id: string, module: WidgetModule, values: Record<string,string>): Promise<BrowseResult> {
  const generation = artworkGeneration;
  if (runsWidget(id)) {
    const result = await executeWidget(id, module.functionName, values);
    if (generation !== artworkGeneration) throw new Error('内容源配置已变化');
    return browseResult(id, result.value, Number(values.page), true, result.logs);
  }
  const query = new URLSearchParams(values);
  let path = `/api/v1/providers/${id}/`;
  if (/search/i.test(module.functionName)) { path += 'search'; query.set('q', values.keyword || ''); query.delete('keyword'); }
  else if (id === 'hongguo') {
    path += 'browse';
    if (module.functionName === 'getHongguoShort') query.set('category', 'short');
    else if (module.functionName === 'getHongguoComic') query.set('category', 'comic');
    else if (module.id.startsWith('hongguo-rank-')) { query.set('category', 'rank'); query.set('rank', module.id.slice('hongguo-rank-'.length)); }
    else throw new Error(`未识别红果分类: ${module.functionName}`);
  } else if (module.functionName === 'getProviderHome') path += 'home';
  else if (module.functionName === 'getProviderCategory') path += 'browse';
  else throw new Error(`Backend 组件接口已变化: ${module.functionName}`);
  const payload = await backendJson(backendUrl + path + '?' + query);
  if (generation !== artworkGeneration) throw new Error('内容源配置已变化');
  return browseResult(id, payload, Number(values.page), false);
}
export async function searchSource(id: string, keyword: string, page: number): Promise<BrowseResult> {
  const { metadata } = await widget(id);
  if (!keyword.trim() || keyword.length > 200) throw new Error('请输入 1–200 字的搜索关键词');
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new Error('页码无效');
  return cachedList(JSON.stringify(['search', id, keyword.trim(), page]), false, () => loadSearch(id, metadata, keyword, page));
}
async function loadSearch(id: string, metadata: WidgetMetadata, keyword: string, page: number): Promise<BrowseResult> {
  const generation = artworkGeneration;
  if (runsWidget(id)) {
    if (!metadata.search) throw new Error('组件未提供搜索');
    const result = await executeWidget(id, metadata.search.functionName, parameters(metadata.search, { keyword: keyword.trim(), page: String(page) }));
    if (generation !== artworkGeneration) throw new Error('内容源配置已变化');
    return browseResult(id, result.value, page, true, result.logs);
  }
  const payload = await backendJson(`${backendUrl}/api/v1/providers/${id}/search?` + new URLSearchParams({ q: keyword.trim(), page: String(page) }));
  if (generation !== artworkGeneration) throw new Error('内容源配置已变化');
  return browseResult(id, payload, page, false);
}
async function recoverListArtwork(id: string, link: string, title: string): Promise<PosterArtwork> {
  const generation = artworkGeneration;
  const { metadata } = await widget(id);
  const key = artworkKey(id, link);
  let itemId = new URL(link, backendUrl).pathname.split('/').filter(Boolean).at(-1) || '';
  try { itemId = decodeURIComponent(itemId); } catch { /* Opaque widget links keep their raw segment. */ }
  const keywords = [...new Set([itemId, title.trim()])].filter(value => value && value.length <= 200);
  if (metadata.search || !runsWidget(id)) {
    for (const keyword of keywords) {
      for (let page = 1; page <= 3; page++) {
        if (generation !== artworkGeneration) throw new Error('内容源配置已变化');
        let result: BrowseResult;
        try { result = await loadSearch(id, metadata, keyword, page); }
        catch { break; }
        const match = result.items.find(item => artworkKey(id, item.link) === key);
        if (match?.posterUrl) return artworkCache.get(key) || { url: match.posterUrl };
        if (!result.hasMore) break;
      }
    }
  }
  if (generation !== artworkGeneration) throw new Error('内容源配置已变化');
  // Providers without searchable IDs can still return an exact match on their landing page.
  const module = metadata.modules.find(entry => !/search|history/i.test(entry.functionName));
  if (module) {
    try {
      const result = await loadBrowse(id, module, parameters(module, { page: '1' }));
      const match = result.items.find(item => artworkKey(id, item.link) === key);
      if (match?.posterUrl) return artworkCache.get(key) || { url: match.posterUrl };
    } catch { /* Unavailable artwork must not prevent playback. */ }
  }
  return { url: '' };
}
export async function resolvePosterArtwork(sourceId: string, input: string, title: string, refresh = false): Promise<PosterArtwork> {
  requireSource(sourceId);
  const link = detailLink(sourceId, input);
  const key = artworkKey(sourceId, link);
  const cached = artworkCache.get(key);
  if (!refresh && cached?.url) return cached;
  const pending = artworkPending.get(key);
  if (pending) return pending;
  const generation = artworkGeneration;
  if (refresh) artworkCache.delete(key);
  const task = (async (): Promise<PosterArtwork> => {
    // MissAV string-link details deliberately have no cover; searching avoids unnecessary playback parsing.
    if (sourceId !== 'missav') {
      const payload = runsWidget(sourceId) ? (await executeWidget(sourceId, 'loadDetail', link)).value : await backendJson(link);
      if (generation !== artworkGeneration) throw new Error('内容源配置已变化');
      const artwork = rememberArtwork(sourceId, link, artworkFromRow(record(payload)));
      if (artwork.url) return artwork;
    }
    const artwork = await recoverListArtwork(sourceId, link, title);
    if (generation !== artworkGeneration) throw new Error('内容源配置已变化');
    return artwork;
  })();
  artworkPending.set(key, task);
  try { return await task; } finally { if (artworkPending.get(key) === task) artworkPending.delete(key); }
}
function customHeaders(value: unknown): Record<string,string> {
  if (value === undefined || value === null) return {};
  const result: Record<string,string> = {};
  for (const [key, entry] of Object.entries(record(value))) if (typeof entry === 'string' && !/[\r\n]/.test(key + entry) && !['host','connection','transfer-encoding','content-length'].includes(key.toLowerCase())) result[key] = entry;
  return result;
}
interface NormalizedDetail { detail: Detail; streams: Map<string, ResolvedStream[]>; }
function normalizeDetail(id: string, link: string, payload: unknown): NormalizedDetail {
  const row = record(payload);
  if (row.error || row.ok === false) throw new Error(String(row.error || row.message || '获取详情失败'));
  const streams = new Map<string, ResolvedStream[]>();
  const seasons: Season[] = [];
  const baseHeaders = customHeaders(row.customHeaders || row.headers);
  const convertEpisode = (value: unknown, seasonNumber: number, index: number): Episode | undefined => {
    const ep = record(value);
    const episodeNumber = Number(ep.episodeNumber || ep.episode || index + 1);
    const upstreamId = String(ep.id || '');
    const stable = upstreamId && !/[/?#]/.test(upstreamId) ? upstreamId : `episode-${episodeNumber}`;
    const episodeId = `s${seasonNumber}:${stable}`;
    const headers = { ...baseHeaders, ...customHeaders(ep.customHeaders || ep.headers) };
    const primary = ep.mediaUrl || ep.streamUrl || ep.videoUrl || ep.playUrl || (ep.type === 'url' ? ep.url : '');
    const variants = Array.isArray(ep.sources) && ep.sources.length ? ep.sources : primary ? [{ url: primary }] : [];
    const candidates = variants.map((entry, variantIndex): ResolvedStream => {
      const variant = typeof entry === 'string' ? { url: entry } : record(entry);
      const url = new URL(String(variant.url || variant.src || variant.videoUrl || ''), backendUrl);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('上游播放地址协议无效');
      return { url: url.href, headers: { ...headers, ...customHeaders(variant.customHeaders || variant.headers) }, title: String(variant.title || variant.label || (variants.length > 1 ? `线路 ${variantIndex + 1}` : '默认线路')), ...(typeof variant.type === 'string' ? { type: variant.type } : {}) };
    });
    const existing = streams.get(episodeId);
    if (existing) {
      // Some widgets repeat one episode (e.g. related-video links on single-episode pages). Identical media URLs are the
      // same episode even when per-link Referers differ; the first entry is kept, anything else stays ambiguous.
      const identity = (entries: ResolvedStream[]) => JSON.stringify(entries.map(entry => [entry.url, entry.type]));
      if (identity(existing) === identity(candidates)) return undefined;
      throw new Error('上游提供重复集数标识，无法安全定位播放集');
    }
    streams.set(episodeId, candidates);
    return { id: episodeId, title: String(ep.title || `第 ${episodeNumber} 集`), episodeNumber, seasonNumber, videoUrl: candidates[0]?.url || '', link: String(ep.pageUrl || ep.link || link), customHeaders: headers, playerType: String(ep.playerType || 'system') };
  };
  if (Array.isArray(row.seasons) && row.seasons.length) {
    for (const [index,value] of row.seasons.entries()) {
      const season = record(value);
      const seasonNumber = Number(season.seasonNumber || index + 1);
      if (!Array.isArray(season.episodes)) throw new Error('上游分季数据缺少剧集列表');
      seasons.push({ seasonNumber, title: String(season.title || `第 ${seasonNumber} 季`), episodes: season.episodes.flatMap((episode, episodeIndex) => convertEpisode(episode, seasonNumber, episodeIndex) ?? []) });
    }
  } else if (Array.isArray(row.episodeItems) && row.episodeItems.length) {
    for (const value of row.episodeItems) {
      const ep = record(value);
      const number = Number(ep.seasonNumber || ep.seasonIndex || 1);
      let season = seasons.find(entry => entry.seasonNumber === number);
      if (!season) { season = { seasonNumber: number, episodes: [] }; seasons.push(season); }
      const episode = convertEpisode(ep, number, season.episodes.length);
      if (episode) season.episodes.push(episode);
    }
  } else if (row.videoUrl || row.mediaUrl || row.streamUrl || row.playUrl) {
    seasons.push({ seasonNumber: 1, title: '正片', episodes: [convertEpisode({ ...row, id: 'feature', title: '播放正片' }, 1, 0)!] });
  }
  const episodeItems = seasons.flatMap(season => season.episodes);
  if (!episodeItems.length || !Array.from(streams.values()).some(entries => entries.length)) throw new Error(String(row.description || row.message || '上游未提供可播放剧集，可能因网络、地区限制或站点风控').slice(0, 1500));
  const artwork = rememberArtwork(id, link, artworkFromRow(row), true);
  const detail: Detail = { id: `${id}:${createHash('sha256').update(link).digest('hex').slice(0,20)}`, sourceId: id, title: String(row.title || row.name || '未命名影片'), posterUrl: artwork.url, description: String(row.description || ''), remark: String(row.remark || ''), mediaType: String(row.mediaType || 'tv'), link, seasons, episodeItems };
  return { detail, streams };
}
// Detail parsing can take many serial upstream page loads; playback reuses a recent result instead of repeating it.
const detailCache = new Map<string, { value: NormalizedDetail; expires: number }>();
const detailCacheTtl = 5 * 60 * 1000;
let detailGeneration = 0;
async function freshDetail(id: string, input: string): Promise<NormalizedDetail> {
  requireSource(id);
  const link = detailLink(id, input);
  const generation = detailGeneration;
  let argument: unknown = link;
  if (id === 'missav') {
    // Reuse browsed artwork without delaying playback for a cold image search.
    // The stable poster endpoint recovers missing artwork independently.
    const artwork = artworkCache.get(artworkKey(id, link));
    if (artwork?.url) argument = { link, detailUrl: link, posterPath: artwork.url, backdropPath: artwork.backdropUrl || artwork.url };
  }
  if (generation !== detailGeneration) throw new Error('内容源配置已变化');
  const payload = runsWidget(id) ? (await executeWidget(id, 'loadDetail', argument)).value : await backendJson(link);
  if (generation !== detailGeneration) throw new Error('内容源配置已变化');
  const value = normalizeDetail(id, link, payload);
  if (generation === detailGeneration) {
    const key = JSON.stringify([id, link]);
    detailCache.delete(key);
    if (detailCache.size >= 100) detailCache.delete(detailCache.keys().next().value!);
    detailCache.set(key, { value, expires: Date.now() + detailCacheTtl });
  }
  return value;
}
function cachedDetail(id: string, input: string): NormalizedDetail | undefined {
  requireSource(id);
  const key = JSON.stringify([id, detailLink(id, input)]);
  const entry = detailCache.get(key);
  if (entry && entry.expires > Date.now()) return entry.value;
  detailCache.delete(key);
  return undefined;
}
export async function getDetail(id: string, link: string): Promise<Detail> {
  return (await freshDetail(id, link)).detail;
}
export async function resolvePlayback(id: string, link: string, episodeId: string, refresh = false): Promise<ResolvedStream[]> {
  const result = (!refresh && cachedDetail(id, link)) || await freshDetail(id, link);
  const candidates = result.streams.get(episodeId);
  if (!candidates) throw new Error('所选剧集已不存在，请刷新详情');
  if (!candidates.length) throw new Error('此集暂未解析到可用播放地址，请稍后重试');
  return candidates;
}

export async function prepareDirectPlayback(candidate: ResolvedStream): Promise<PlaybackSource> {
  let url = new URL(candidate.url);
  let type = candidate.type;
  if (url.origin === backendUrl) {
    // Only the documented JSON resolver is used; never fetch a stream or playlist to guess its origin.
    const match = url.pathname.match(/^\/api\/v1\/(?:playback|stream)\/([^/]+)(?:\/(?:media|playlist\.m3u8))?$/);
    if (match) {
      const payload = await backendJson(`${backendUrl}/api/v1/playback/${match[1]}`);
      if (typeof payload.videoUrl === 'string' && payload.videoUrl) url = new URL(payload.videoUrl, backendUrl);
      if (typeof payload.contentType === 'string') type = payload.contentType;
    }
    if (url.origin === backendUrl) throw new Error('上游只提供中转地址，未提供可用的视频源直链；请开启“服务器代理中转”或切换来源。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('上游直链地址无效');
  // No media probe, grants, playlist rewrites or custom headers: the browser owns media requests.
  return { src: url.href, type: type || (/\.m3u8$/i.test(url.pathname) ? 'application/x-mpegURL' : 'video/mp4'), title: candidate.title };
}
export function clearProviderCaches(): void {
  artworkGeneration++;
  artworkCache.clear();
  artworkPending.clear();
  detailGeneration++;
  detailCache.clear();
  listGeneration++;
  listCache.clear();
  listPending.clear();
  widgets.clear();
  widgetPending.clear();
  discovery = undefined;
  discovered = undefined;
}

export function closeProviders(): void {
  stopped = true;
  for (const waiter of widgetWaiters.splice(0)) waiter.reject(new Error('内容源服务已关闭'));
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const controller of requests) controller.abort();
  requests.clear();
  clearProviderCaches();
}
