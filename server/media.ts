import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isAllowedUpstreamAddress, resolveUpstreamHost } from './provider-network.js';
import { backendUrl } from './config.js';
import type { FastifyInstance } from 'fastify';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { PlaybackSource } from '../src/types.js';
import { canAccessSource } from './accounts.js';


export interface MediaScope { userId: string; sourceId: string; }
interface MediaGrant extends MediaScope { url: string; headers: Record<string, string>; expires: number; }
const grants = new Map<string, MediaGrant>();
const grantKeys = new Map<string, string>();
const lifetime = 6 * 60 * 60 * 1000;
let grantRevision = 0;
/** Media type last observed per source; each source's resolver returns one consistent format. */
const sourceTypes = new Map<string, string>();

export function clearMediaGrants(): void {
  grantRevision++;
  grants.clear();
  grantKeys.clear();
  sourceTypes.clear();
}

export function rememberSourceType(sourceId: string, type: string): void {
  sourceTypes.set(sourceId, type);
}

function grantMedia(url: string, headers: Record<string, string>, scope: MediaScope, expires = Date.now() + lifetime): string {
  if (grants.size >= 20000) {
    for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key);
    for (const [key, token] of grantKeys) if (!grants.has(token)) grantKeys.delete(key);
    if (grants.size >= 20000) throw new Error('媒体会话已满，请稍后重试');
  }
  const key = JSON.stringify([scope.userId, scope.sourceId, url, headers]);
  const existing = grantKeys.get(key);
  if (existing && (grants.get(existing)?.expires || 0) > Date.now() + 60000) return `/api/media/${existing}`;
  const token = randomBytes(24).toString('base64url');
  grants.set(token, { url, headers, expires, userId: scope.userId, sourceId: scope.sourceId });
  grantKeys.set(key, token);
  return `/api/media/${token}`;
}

// DNS is checked and pinned to the connection; checking then using ordinary fetch would allow rebinding.
export async function openMedia(raw: string, suppliedHeaders: Record<string, string> = {}, range?: string, signal?: AbortSignal): Promise<{ response: IncomingMessage; url: URL; headers: Record<string, string> }> {
  const revision = grantRevision;
  let url = new URL(raw);
  let headers = { ...suppliedHeaders };
  for (let redirect = 0; redirect <= 6; redirect++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不允许的媒体地址');
    const configuredBackend = url.origin === backendUrl && /^\/api\/v1\/(?:stream\/|playback\/|providers\/|subtitles\/|video\/p\/|missav\/playlists\/)/.test(url.pathname);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await resolveUpstreamHost(hostname, configuredBackend);
    if (revision !== grantRevision) throw new Error('上游配置已更改，请重新选择当前集');
    if (!addresses.length || (!configuredBackend && addresses.some(item => !isAllowedUpstreamAddress(item.address)))) throw new Error('媒体地址指向受保护的网络');
    const pinned = addresses[0]!;
    const safeHeaders: Record<string, string> = { 'accept-encoding': 'identity' };
    for (const [key, value] of Object.entries(headers)) {
      if (['user-agent', 'referer', 'origin', 'cookie', 'authorization', 'accept'].includes(key.toLowerCase()) && !/[\r\n]/.test(value)) safeHeaders[key.toLowerCase()] = value;
    }
    if (range && /^bytes=\d*-\d*(?:,\d*-\d*)*$/.test(range)) safeHeaders.range = range;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        headers: safeHeaders, signal,
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, resolve);
      request.on('error', reject);
      request.setTimeout(45000, () => request.destroy(new Error('媒体服务器响应超时')));
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
      const next = new URL(response.headers.location, url);
      response.destroy();
      if (next.origin !== url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['cookie', 'authorization'].includes(key.toLowerCase())));
      url = next;
      continue;
    }
    return { response, url, headers };
  }
  throw new Error('媒体重定向次数过多');
}

export function rewritePlaylist(text: string, base: string, headers: Record<string, string>, scope: MediaScope, expires?: number, accessToken?: string): string {
  const variables = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-DEFINE:')) {
      const name = line.match(/NAME="([^"]+)"/)?.[1];
      const value = line.match(/VALUE="([^"]*)"/)?.[1];
      if (name && value !== undefined) variables.set(name, value);
    }
  }
  const rewrite = (uri: string) => {
    if (uri.startsWith('data:')) return uri;
    const expanded = uri.replace(/\{\$([^}]+)\}/g, (_match, name: string) => {
      if (!variables.has(name)) throw new Error(`播放列表使用了无法解析的变量：${name}`);
      return variables.get(name)!;
    });
    const target = new URL(expanded, base);
    if (!['https:', 'http:'].includes(target.protocol)) throw new Error('播放列表含不支持的媒体协议');
    const childHeaders = target.origin === new URL(base).origin ? headers : Object.fromEntries(Object.entries(headers).filter(([key]) => !['cookie', 'authorization'].includes(key.toLowerCase())));
    const path = grantMedia(target.href, childHeaders, scope, expires);
    return accessToken ? `${path}?api_key=${encodeURIComponent(accessToken)}` : path;
  };
  return text.split(/\r?\n/).map(line => {
    const clean = line.trim();
    if (!clean) return line;
    if (clean.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${rewrite(uri)}"`);
    return rewrite(clean);
  }).join('\n');
}

export async function preparePlayback(candidate: { url: string; headers: Record<string, string>; title: string; type?: string }, scope: MediaScope): Promise<PlaybackSource> {
  const { response, url } = await openMedia(candidate.url, candidate.headers, 'bytes=0-2047');
  const status = response.statusCode || 502;
  const contentType = String(response.headers['content-type'] || '').split(';')[0]!;
  response.destroy();
  if (status < 200 || status >= 300) throw new Error(`媒体服务器返回 HTTP ${status}`);
  const type = candidate.type || (/mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(url.href) ? 'application/x-mpegURL' : /^video\//.test(contentType) ? contentType : 'video/mp4');
  if (!candidate.type) rememberSourceType(scope.sourceId, type);
  return { src: grantMedia(candidate.url, candidate.headers, scope), type, title: candidate.title };
}

/**
 * Grant a candidate without the preflight request when its type is already known. The preflight only
 * detects the type and fails early; the media route still validates every destination when it is fetched.
 */
export function grantPlayback(candidate: { url: string; headers: Record<string, string>; title: string; type?: string }, scope: MediaScope): PlaybackSource | undefined {
  const path = new URL(candidate.url).pathname;
  const type = candidate.type || (/\.m3u8$/i.test(path) ? 'application/x-mpegURL' : /\.(?:mp4|m4v|mov)$/i.test(path) ? 'video/mp4' : sourceTypes.get(scope.sourceId));
  return type ? { src: grantMedia(candidate.url, candidate.headers, scope), type, title: candidate.title } : undefined;
}

export function registerMediaRoutes(app: FastifyInstance): void {
  app.get<{ Params: { token: string }; Querystring: { api_key?: string } }>('/api/media/:token', async (request, reply) => {
    const grant = grants.get(request.params.token);
    const revision = grantRevision;
    if (!grant || grant.expires <= Date.now()) return reply.code(410).send({ error: '播放地址已过期，请重新选择当前集' });
    if (!request.account || request.account.id !== grant.userId || !canAccessSource(request.account, grant.sourceId)) return reply.code(403).send({ error: '无权访问此媒体' });
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    const { response, url, headers } = await openMedia(grant.url, grant.headers, request.headers.range, controller.signal);
    const status = response.statusCode || 502;
    if (status < 200 || status >= 300) {
      const range = response.headers['content-range'];
      response.destroy();
      if (status === 416 && range) reply.header('Content-Range', range);
      return reply.code(status >= 400 && status <= 599 ? status : 502).send({ error: `媒体服务器返回 HTTP ${status}` });
    }
    const type = String(response.headers['content-type'] || 'application/octet-stream');
    if (/mpegurl/i.test(type) || /\.m3u8(?:$|\?)/i.test(url.href)) {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) { response.destroy(); throw new Error('播放列表超过大小限制'); }
        chunks.push(Buffer.from(chunk));
      }
      const encoded = Buffer.concat(chunks);
      const encoding = response.headers['content-encoding'];
      const options = { maxOutputLength: 4 * 1024 * 1024 };
      const decoded = encoding === 'gzip' ? gunzipSync(encoded, options) : encoding === 'br' ? brotliDecompressSync(encoded, options) : encoding === 'deflate' ? inflateSync(encoded, options) : encoded;
      const text = decoded.toString('utf8');
      if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('源站未返回有效 HLS 播放列表');
      if (revision !== grantRevision) return reply.code(410).send({ error: '上游配置已更改，请重新选择当前集' });
      const accessToken = typeof request.query.api_key === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(request.query.api_key) ? request.query.api_key : undefined;
      return reply.header('Content-Type', 'application/vnd.apple.mpegurl').header('Cache-Control', 'no-store').send(rewritePlaylist(text, url.href, headers, grant, grant.expires, accessToken));
    }
    reply.code(status).header('Content-Type', type).header('Cache-Control', 'private, no-store');
    for (const key of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'content-encoding']) if (response.headers[key]) reply.header(key, response.headers[key]);
    return reply.send(response);
  });
}
