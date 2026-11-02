import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browseSource, clearProviderCaches, refreshSourceRegistry, closeProviders, getDetail, listSources, peekPosterArtwork, prepareDirectPlayback, resolvePlayback, resolvePosterArtwork, searchSource } from './providers.js';
import { clearMediaGrants, preparePlayback, registerMediaRoutes } from './media.js';
import { backendUrl, ConfigError, getConfig, normalizeBackendUrl, saveBackendUrl, withSourceOperation } from './config.js';
import type { BrowseResult, Detail, MediaItem, SourceHealth } from '../src/types.js';
import { AccountDatabase, registerAccountRoutes, requireSourceAccess, type User } from './accounts.js';
import { isKnownSource, onSourcesAdded, sourceEntries, sourceIdPattern } from './source-registry.js';
import { registerLibraryRoutes } from './library.js';
import { createPosterService, posterId } from './posters.js';
import { Catalog, rebaseProviderLink } from './catalog.js';
import { CatalogSynchronizer } from './catalog-sync.js';
import { isEmbyPath, registerEmbyRoutes } from './emby.js';
import { EmbyDiscovery } from './discovery.js';

// Source ids come from the upstream at runtime; handlers reject ids the registry does not know.
const sourceParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: sourceIdPattern } } };
const statuses = new Map<string, SourceHealth>();
const status = (id: string): SourceHealth => {
  if (!isKnownSource(id)) throw new ConfigError('未知视频源', 404);
  let entry = statuses.get(id);
  if (!entry) statuses.set(id, entry = {});
  return entry;
};
/** How long a source search waits for the upstream before answering from the catalog, when the catalog has matches. */
const localSearchBudgetMs = 5000;
const localSearchPageSize = 30;

export async function createApp() {
  const accounts = new AccountDatabase();
  try { await accounts.initialize(); }
  catch (error) { accounts.close(); throw error; }
  const catalog = new Catalog(accounts);
  const stopWatchingSources = onSourcesAdded(() => catalog.ensureLibraries());
  const app = Fastify({
    logger: true, bodyLimit: 16384, requestTimeout: 180000, routerOptions: { maxParamLength: 256, caseSensitive: false },
    // Some Emby clients prefix /emby onto stream URLs whose base already ends in /emby; collapse the duplicates.
    rewriteUrl: request => (request.url || '/').replace(/^(?:\/emby)+(?=\/)/i, '/emby'),
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
  });
  app.addHook('onRequest', async (request, reply) => {
    if (isEmbyPath(request.url)) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    let sameOrigin = !origin;
    if (origin) {
      try { sameOrigin = new URL(origin).host === request.headers.host; }
      catch { sameOrigin = false; }
    }
    if (!sameOrigin || request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: '不允许跨站操作' });
  });
  app.setErrorHandler((error, request, reply) => {
    const message = error instanceof Error ? error.message : '服务请求失败';
    request.log.warn({ err: error }, 'Request failed');
    const validation = typeof error === 'object' && error !== null && 'validation' in error;
    reply.code(validation ? 400 : error instanceof ConfigError ? error.statusCode : 502).send({ error: validation ? '请求参数无效' : message });
  });
  app.addHook('onRoute', route => {
    if (route.url !== '/api/sources' && !route.url.startsWith('/api/sources/') && !route.url.startsWith('/api/posters/')) return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      return withSourceOperation(() => handler.call(this, request, reply));
    };
  });
  app.addHook('onClose', async () => { stopWatchingSources(); accounts.close(); });
  registerAccountRoutes(app, accounts);
  const posters = createPosterService(app, accounts, resolvePosterArtwork);
  const presentMedia = <T extends MediaItem>(item: T): T =>
    posters.decorate(item, peekPosterArtwork(item.sourceId, item.link) || (item.posterUrl ? { url: item.posterUrl } : undefined));
  /** Titles of one source matching a search, from the catalog, shaped like an upstream search page. */
  const localSearch = (user: User, sourceId: string, keyword: string, page: number): BrowseResult => {
    const start = (page - 1) * localSearchPageSize;
    const result = catalog.query(user, {
      parentId: Catalog.libraryId(sourceId), recursive: true, search: keyword.trim().slice(0, 200), includeTypes: ['Series', 'Movie'],
      sortBy: 'DateCreated', descending: true, start, limit: localSearchPageSize,
    });
    return {
      items: result.items.map(item => ({
        id: item.upstreamId, title: item.name, posterUrl: item.posterUrl, description: item.overview,
        link: item.link, mediaType: item.mediaType, sourceId: item.sourceId,
      })),
      page, hasMore: start + result.items.length < result.total, total: result.total,
      pageCount: Math.max(1, Math.ceil(result.total / localSearchPageSize)), local: true,
    };
  };
  const detailLoads = new Map<string, Promise<Detail>>();
  const loadAndCacheDetail = (sourceId: string, link: string): Promise<Detail> => {
    const key = JSON.stringify([backendUrl, sourceId, link]);
    const pending = detailLoads.get(key);
    if (pending) return pending;
    const load = getDetail(sourceId, link).then(detail => {
      const presented = presentMedia(detail);
      catalog.ingestDetail(presented);
      return presented;
    }).finally(() => detailLoads.delete(key));
    detailLoads.set(key, load);
    return load;
  };
  // Titles saved from an earlier backend are unusable (links and poster ids embed its root); move them over.
  // That rewrites up to a million rows, so it runs in the background in short batches instead of holding the
  // request (and every other one) for minutes. A newer backend change or shutdown stops a running move; the
  // next run picks up whatever it left.
  let closing = false;
  let migration = Promise.resolve();
  let migratingTo = '';
  const adoptBackend = () => {
    const target = backendUrl;
    // Only an actual move is reported; the run itself still checks everything (e.g. stale poster URLs).
    migratingTo = posters.hasForeignRows() || catalog.hasForeignTitles(target) ? target : '';
    const stopped = () => closing || backendUrl !== target;
    migration = migration.then(async () => {
      if (stopped()) return;
      const started = performance.now();
      const posterUrl = (sourceId: string, link: string) => `/api/posters/${posterId(target, sourceId, link)}`;
      const posterRows = await posters.migrateBackend((sourceId, link) => rebaseProviderLink(sourceId, link, target), stopped);
      const titles = await catalog.rebaseBackend(target, posterUrl, stopped);
      const posterUrls = stopped() ? 0 : await catalog.refreshPosterUrls(posterUrl, stopped);
      if (posterRows || titles || posterUrls) {
        app.log.info({ backendUrl: target, posterRows, titles, posterUrls, complete: !stopped(), ms: Math.round(performance.now() - started) }, 'Catalog moved to the current backend');
      }
    }).catch(error => app.log.error({ err: error, backendUrl: target }, 'Moving the catalog to the current backend failed'))
      .finally(() => { if (migratingTo === target) migratingTo = ''; });
  };
  adoptBackend();
  // Catalogs that predate the search index fill it in the background; searches scan the catalog until it is complete.
  const searchIndex = (async () => {
    const started = performance.now();
    const rows = await catalog.buildSearchIndex(() => closing);
    if (rows) app.log.info({ rows, complete: !closing, ms: Math.round(performance.now() - started) }, 'Catalog search index built');
  })().catch(error => app.log.error({ err: error }, 'Building the catalog search index failed'));
  app.addHook('preClose', async () => { closing = true; await Promise.all([migration, searchIndex]); });
  const catalogSync = new CatalogSynchronizer(catalog, presentMedia, loadAndCacheDetail, posters.prefetch, app.log);
  app.addHook('onReady', async () => catalogSync.start());
  app.addHook('onClose', async () => catalogSync.close());
  const discovery = new EmbyDiscovery(catalog.serverId, app.log);
  app.addHook('onReady', async () => discovery.start());
  app.addHook('onClose', async () => discovery.close());
  registerLibraryRoutes(app, accounts, item => posters.decorate(item), catalog);
  registerEmbyRoutes(app, accounts, catalog, posters, loadAndCacheDetail);
  const configState = () => ({ ...getConfig(), ...(migratingTo ? { migrating: true } : {}) });
  app.get('/api/config', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(configState()));
  app.post<{ Body: { backendUrl: string } }>('/api/config', {
    schema: { body: { type: 'object', required: ['backendUrl'], properties: { backendUrl: { type: 'string', minLength: 1, maxLength: 4096 } }, additionalProperties: false } },
  }, async (request, reply) => {
    const next = normalizeBackendUrl(request.body.backendUrl);
    if (new URL(next).host === request.headers.host?.toLowerCase()) throw new ConfigError('上游地址不能是当前播放器自身的地址', 400);
    await saveBackendUrl(next, () => {
      clearProviderCaches();
      clearMediaGrants();
      posters.clear();
      adoptBackend();
      statuses.clear();
    });
    return reply.header('Cache-Control', 'no-store').send(configState());
  });
  // Administrators also see sources registered by this request's own discovery.
  app.get('/api/sources', async request => listSources(request.account!.role === 'admin' ? () => true : request.account!.sourceIds));
  app.get<{ Querystring: { sourceId?: string; q?: string; start?: string; limit?: string } }>('/api/catalog', async request => {
    const sourceId = request.query.sourceId;
    if (sourceId) requireSourceAccess(request.account, sourceId);
    const result = catalog.query(request.account!, {
      parentId: sourceId ? Catalog.libraryId(sourceId) : '',
      recursive: !sourceId,
      search: request.query.q?.trim().slice(0, 200),
      includeTypes: ['Series', 'Movie'],
      sortBy: 'DateCreated',
      descending: true,
      start: Math.max(0, Number(request.query.start || 0) || 0),
      limit: Math.min(200, Math.max(1, Number(request.query.limit || 60) || 60)),
    });
    return {
      items: result.items.map(item => ({
        id: item.id, title: item.name, posterUrl: item.posterUrl, description: item.overview,
        link: item.link, mediaType: item.mediaType, sourceId: item.sourceId,
      })),
      total: result.total,
    };
  });
  app.get('/api/status', async request => ({ backendUrl: request.account?.role === 'admin' ? backendUrl : '', sources: Object.fromEntries(request.account!.sourceIds.map(id => [id, statuses.get(id) || {}])) }));
  app.get('/api/admin/sources', async request => {
    if (request.account?.role !== 'admin') throw new ConfigError('仅管理员可查看来源列表', 403);
    if (backendUrl) await refreshSourceRegistry();
    return { sources: sourceEntries() };
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/admin/catalog/status', async request => {
    if (request.account?.role !== 'admin') throw new ConfigError('仅管理员可查看媒体库同步状态', 403);
    return { serverId: catalog.serverId, sources: catalog.syncStatus() };
  });
  app.post<{ Body: { sourceId?: string } }>('/api/admin/catalog/sync', {
    schema: { body: { type: 'object', properties: { sourceId: { type: 'string', pattern: sourceIdPattern } }, additionalProperties: false } },
  }, async (request, reply) => {
    if (request.account?.role !== 'admin') throw new ConfigError('仅管理员可同步媒体库', 403);
    if (request.body.sourceId && !isKnownSource(request.body.sourceId)) throw new ConfigError('未知视频源', 400);
    void catalogSync.scanAll(request.body.sourceId ? [request.body.sourceId] : undefined);
    return reply.code(202).send({ accepted: true });
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/sources/:id/browse', {
    schema: { params: sourceParams, querystring: { type: 'object', properties: { module: { type: 'string', maxLength: 200 }, page: { type: 'string', pattern: '^[1-9][0-9]{0,4}$' } }, additionalProperties: { type: 'string', maxLength: 500 } } },
  }, async request => {
    const id = request.params.id;
    try {
      const result = await browseSource(id, request.query.module, request.query);
      status(id).browse = { ok: true, message: `返回 ${result.items.length} 个结果`, at: Date.now() };
      const items = result.items.map(presentMedia);
      catalog.ingestBrowse({ ...result, items });
      return { ...result, items };
    } catch (error) {
      status(id).browse = { ok: false, message: error instanceof Error ? error.message : '浏览失败', at: Date.now() };
      throw error;
    }
  });
  app.get<{ Params: { id: string }; Querystring: { q: string; page?: string } }>('/api/sources/:id/search', {
    schema: { params: sourceParams, querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 1, maxLength: 200 }, page: { type: 'string', pattern: '^[1-9][0-9]{0,4}$' } }, additionalProperties: false } },
  }, async request => {
    const id = request.params.id;
    const page = Number(request.query.page || 1);
    const pending = searchSource(id, request.query.q, page);
    // A slow or failing upstream should not hide titles the catalog already holds: give it a budget, then answer locally.
    const local = localSearch(request.account!, id, request.query.q, page);
    let timer: NodeJS.Timeout | undefined;
    const budget = local.items.length ? new Promise<'timeout'>(resolve => { timer = setTimeout(resolve, localSearchBudgetMs, 'timeout'); }) : undefined;
    try {
      const result = budget ? await Promise.race([pending, budget]) : await pending;
      if (result === 'timeout') throw new Error(`上游搜索超过 ${localSearchBudgetMs / 1000} 秒未响应`);
      status(id).search = { ok: true, message: `返回 ${result.items.length} 个结果`, at: Date.now() };
      const items = result.items.map(presentMedia);
      catalog.ingestBrowse({ ...result, items });
      return { ...result, items };
    } catch (error) {
      const message = error instanceof Error ? error.message : '搜索失败';
      if (local.items.length) {
        // A late upstream answer still fills the list cache for the next search; its failure is already reported.
        pending.catch(() => undefined);
        status(id).search = { ok: false, message: `${message}；已返回本地媒体库的 ${local.total} 个结果`, at: Date.now() };
        request.log.warn({ err: error, sourceId: id }, 'Upstream search failed; answered from the catalog');
        return local;
      }
      status(id).search = { ok: false, message, at: Date.now() };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
  app.get<{ Params: { id: string }; Querystring: { link: string } }>('/api/sources/:id/detail', {
    schema: { params: sourceParams, querystring: { type: 'object', required: ['link'], properties: { link: { type: 'string', minLength: 1, maxLength: 4096 } }, additionalProperties: false } },
  }, async request => {
    const id = request.params.id;
    const cached = catalog.cachedDetail(id, request.query.link);
    if (cached) {
      status(id).detail = { ok: true, message: `本地缓存返回 ${cached.episodeItems.length} 个分集`, at: Date.now() };
      return cached;
    }
    try {
      const result = await loadAndCacheDetail(id, request.query.link);
      status(id).detail = { ok: true, message: `返回 ${result.episodeItems.length} 个分集`, at: Date.now() };
      return result;
    } catch (error) {
      status(id).detail = { ok: false, message: error instanceof Error ? error.message : '详情失败', at: Date.now() };
      throw error;
    }
  });
  app.post<{ Params: { id: string }; Body: { link: string; episodeId: string; serverProxy?: boolean; refresh?: boolean } }>('/api/sources/:id/playback', {
    schema: { params: sourceParams, body: { type: 'object', required: ['link', 'episodeId'], properties: { link: { type: 'string', minLength: 1, maxLength: 4096 }, episodeId: { type: 'string', minLength: 1, maxLength: 4096 }, serverProxy: { type: 'boolean', default: true }, refresh: { type: 'boolean', default: false } }, additionalProperties: false } },
  }, async request => {
    const candidates = await resolvePlayback(request.params.id, request.body.link, request.body.episodeId, request.body.refresh);
    const scope = { userId: request.account!.id, sourceId: request.params.id };
    const prepared = await Promise.allSettled(candidates.map(candidate => request.body.serverProxy === false ? prepareDirectPlayback(candidate) : preparePlayback(candidate, scope)));
    const sources = prepared.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    if (!sources.length) {
      const failure = prepared.find(result => result.status === 'rejected');
      throw failure?.reason || new Error('该集没有可播放的地址');
    }
    return { sources };
  });
  app.post<{ Params: { id: string }; Body: { ok: boolean; message: string } }>('/api/sources/:id/playback-report', {
    schema: { params: sourceParams, body: { type: 'object', required: ['ok', 'message'], properties: { ok: { type: 'boolean' }, message: { type: 'string', maxLength: 500 } }, additionalProperties: false } },
  }, async request => {
    status(request.params.id).playback = { ...request.body, at: Date.now() };
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/check', { schema: { params: sourceParams } }, async request => {
    const id = request.params.id;
    try {
      const source = (await listSources([id])).find(item => item.id === id);
      if (!source || source.error) throw new Error(source?.error || '视频源不可用');
      const module = source.modules.find(item => !/history|search/i.test(item.id));
      const result = await browseSource(id, module?.id, { page: '1' }, true);
      status(id).browse = { ok: true, message: `返回 ${result.items.length} 个结果；播放需在播放器中验证`, at: Date.now() };
    } catch (error) {
      status(id).browse = { ok: false, message: error instanceof Error ? error.message : '检测失败', at: Date.now() };
    }
    return status(id);
  });
  registerMediaRoutes(app);
  const dist = resolve('dist/client');
  if (existsSync(resolve(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false, index: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/server/')) return reply.code(404).send({ error: '接口不存在' });
      if (request.url.startsWith('/emby/') || isEmbyPath(request.url)) return reply.code(404).send({ ErrorCode: 'ResourceNotFound', Message: 'Emby API endpoint not implemented' });
      return reply.sendFile('index.html');
    });
  }
  app.addHook('onClose', async () => closeProviders());
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await app.listen({ port: Number(process.env.PORT || 8789), host: process.env.HOST || '0.0.0.0' });
}
