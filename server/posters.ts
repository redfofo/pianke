import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, readFile, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canAccessSource } from './accounts.js';
import type { AccountDatabase } from './accounts.js';
import { backendUrl, ConfigError } from './config.js';
import { assertPublicUpstreamUrl, safeBinaryRequest } from './provider-network.js';
import { isKnownSource } from './source-registry.js';

export interface PosterArtwork { url: string; fallbackUrls?: string[]; headers?: Record<string,string>; }
type ResolveArtwork = (sourceId: string, link: string, title: string, refresh?: boolean) => Promise<PosterArtwork>;
interface PosterRow { id: string; backend: string; sourceId: string; link: string; title: string; artwork: string; artworkAt: number; touchedAt: number; }
interface Image { bytes: Buffer; type: string; fingerprint: string; expires: number; }
interface Flight { controller: AbortController; fingerprint: string; generation: number; promise: Promise<Image>; }
const maxImageBytes = 8 * 1024 * 1024;
/** Poster rows (and their cache files) moved per transaction when the backend changes. */
const migrateBatchRows = 500;
const maxCacheBytes = 32 * 1024 * 1024;
const cacheLifetime = 10 * 60 * 1000;
const artworkLifetime = 6 * 60 * 60 * 1000;
const metadataLifetime = 90 * 24 * 60 * 60 * 1000;
/** How long a title whose artwork lookup failed upstream answers at once instead of asking (and waiting on) it again. */
const resolveFailureLifetime = 5 * 60 * 1000;
const diskMagic = 'SPC1\n';
const safeHeaderNames: Record<string, true> = { accept: true, 'accept-language': true, 'user-agent': true, referer: true, origin: true };
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function fingerprint(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** Stable poster id of a title on a backend; the same id names its metadata row and disk cache file. */
export function posterId(backend: string, sourceId: string, link: string): string { return fingerprint(JSON.stringify([backend, sourceId, link])); }
function normalizeArtwork(artwork: PosterArtwork): string {
  const urls = [artwork.url, ...(artwork.fallbackUrls || [])].filter((value): value is string => typeof value === 'string' && !!value && value.length <= 8192);
  const unique = [...new Set(urls)].slice(0, 4);
  const headers: Record<string,string> = {};
  for (const [name, value] of Object.entries(artwork.headers || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const key = name.toLowerCase();
    if (Object.hasOwn(safeHeaderNames, key) && typeof value === 'string' && value.length <= 4096 && !/[\r\n\0]/.test(value)) headers[key] = value;
  }
  return JSON.stringify({ url: unique[0] || '', ...(unique.length > 1 ? { fallbackUrls: unique.slice(1) } : {}), ...(Object.keys(headers).length ? { headers } : {}) });
}
function dimensions(width: number, height: number): void {
  if (!width || !height || width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024) throw new Error('封面尺寸无效或过大');
}
function invalidImage(): never { throw new Error('上游未返回有效的光栅封面'); }
/** Inspect the actual container, never the server's MIME claim. SVG and AVIF are not accepted. */
function rasterType(bytes: Buffer): string {
  if (bytes.length < 12) return invalidImage();
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    let frame = false;
    let scan = false;
    let quantization = false;
    let huffman = false;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return invalidImage();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9) {
        // Some source CDNs append CR/LF or NUL padding after EOI; browsers decode these normally.
        const padding = bytes.subarray(offset).every(byte => byte === 0 || byte === 9 || byte === 10 || byte === 13 || byte === 32);
        return frame && scan && quantization && huffman && padding ? 'image/jpeg' : invalidImage();
      }
      if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return invalidImage();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return invalidImage();
      if (marker === 0xdb || marker === 0xc4) {
        let table = offset + 2;
        while (table < offset + length) {
          const selector = bytes[table++]!;
          if ((selector & 15) > 3 || (selector >>> 4) > 1) return invalidImage();
          if (marker === 0xdb) {
            table += selector >>> 4 ? 128 : 64;
          } else {
            if (table + 16 > offset + length) return invalidImage();
            let symbols = 0;
            for (let index = 0; index < 16; index++) symbols += bytes[table + index]!;
            if (!symbols || symbols > 256) return invalidImage();
            table += 16 + symbols;
          }
        }
        if (table !== offset + length || length === 2) return invalidImage();
        if (marker === 0xdb) quantization = true; else huffman = true;
      }
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || bytes[offset + 2] !== 8 || ![1, 3, 4].includes(bytes[offset + 7]!) || length !== 8 + 3 * bytes[offset + 7]!) return invalidImage();
        dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
        frame = true;
      }
      offset += length;
      if (marker === 0xda) {
        const components = bytes[offset - length + 2]!;
        if (!frame || !quantization || !huffman || components < 1 || components > 4 || length !== 6 + 2 * components) return invalidImage();
        scan = true;
        const start = offset;
        while (offset < bytes.length) {
          if (bytes[offset] !== 0xff) { offset++; continue; }
          const next = bytes[offset + 1];
          if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
          break;
        }
        if (offset === start) return invalidImage();
      }
    }
    return invalidImage();
  }
  if (bytes.subarray(0, 8).equals(pngSignature)) {
    let offset = 8;
    let header = false;
    let data = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return invalidImage();
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return invalidImage();
      if (!header && kind !== 'IHDR') return invalidImage();
      if (kind === 'IHDR') {
        if (header || length !== 13) return invalidImage();
        dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
        const depth = bytes[offset + 16]!;
        const color = bytes[offset + 17]!;
        if (!(color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [2, 4, 6].includes(color) ? [8, 16] : []).includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20]! > 1) return invalidImage();
        header = true;
      }
      if (kind === 'IDAT' && length) data = true;
      if (kind === 'IEND') return header && data && length === 0 && end === bytes.length ? 'image/png' : invalidImage();
      offset = end;
    }
    return invalidImage();
  }
  const signature = bytes.toString('ascii', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    if (bytes.length < 14) return invalidImage();
    dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
    let offset = 13 + (bytes[10]! & 0x80 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0);
    let frames = 0;
    let pixels = 0;
    const blocks = () => {
      let size: number;
      do { if (offset >= bytes.length) return invalidImage(); size = bytes[offset++]!; offset += size; } while (size && offset <= bytes.length);
      if (offset > bytes.length) return invalidImage();
    };
    while (offset < bytes.length) {
      const kind = bytes[offset++];
      if (kind === 0x3b) return frames && offset === bytes.length ? 'image/gif' : invalidImage();
      if (kind === 0x21) { offset++; blocks(); continue; }
      if (kind !== 0x2c || offset + 9 > bytes.length) return invalidImage();
      const width = bytes.readUInt16LE(offset + 4);
      const height = bytes.readUInt16LE(offset + 6);
      dimensions(width, height);
      pixels += width * height;
      if (++frames > 128 || pixels > 64 * 1024 * 1024) return invalidImage();
      const flags = bytes[offset + 8]!;
      offset += 9 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
      const codeSize = bytes[offset++];
      if (codeSize === undefined || codeSize < 2 || codeSize > 8 || !bytes[offset]) return invalidImage();
      blocks();
    }
    return invalidImage();
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    let offset = 12;
    let image = false;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('ascii', offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + length > bytes.length) return invalidImage();
      if (kind === 'VP8X') {
        if (length !== 10 || bytes[start]! & 2) return invalidImage();
        dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1);
      } else if (kind === 'VP8 ') {
        if (image || length < 11 || bytes[start]! & 1 || bytes.toString('hex', start + 3, start + 6) !== '9d012a') return invalidImage();
        dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff);
        image = true;
      } else if (kind === 'VP8L') {
        if (image || length < 6 || bytes[start] !== 0x2f || bytes[start + 4]! & 0xe0) return invalidImage();
        const bits = bytes.readUInt32LE(start + 1);
        dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        image = true;
      }
      offset = start + length + (length & 1);
    }
    return image && offset === bytes.length ? 'image/webp' : invalidImage();
  }
  return invalidImage();
}

async function validateNestedTarget(value: string, backend: string, depth = 0): Promise<void> {
  const target = new URL(value);
  if (target.origin === backend || depth > 3) throw new Error('不允许的嵌套封面地址');
  await assertPublicUpstreamUrl(target.href);
  for (const [name, nested] of target.searchParams) {
    if (/^(?:url|uri|src|target|image|cover)$/i.test(name) || /^(?:https?:|\/\/)/i.test(nested)) await validateNestedTarget(nested, backend, depth + 1);
  }
}
async function validateArtworkUrl(url: URL, row: PosterRow): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('不允许的封面地址');
  if (url.origin !== row.backend) return;
  // Backend image proxies only; nested targets below must be public. Widgets share the generic MissAV/image proxies.
  const covers = [`/api/v1/providers/${row.sourceId}/cover`, `/api/v1/${row.sourceId}/cover`, '/api/v1/missav/cover', '/api/v1/image-proxy'];
  if (!covers.includes(url.pathname)) throw new Error('不允许的上游封面路径');
  for (const [name, value] of url.searchParams) {
    if (/^(?:url|uri|src|target|image|cover)$/i.test(name) || /^(?:https?:|\/\/)/i.test(value)) await validateNestedTarget(value, row.backend);
  }
}

export function createPosterService(app: FastifyInstance, accounts: AccountDatabase, resolveArtwork: ResolveArtwork) {
  accounts.db.exec(`
    CREATE TABLE IF NOT EXISTS poster_assets (
      id TEXT PRIMARY KEY, backend TEXT NOT NULL, sourceId TEXT NOT NULL, link TEXT NOT NULL,
      title TEXT NOT NULL, artwork TEXT NOT NULL, artworkAt INTEGER NOT NULL, touchedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS poster_assets_touched ON poster_assets(touchedAt);
  `);
  const getRow = accounts.db.prepare('SELECT * FROM poster_assets WHERE id = ?');
  const putRow = accounts.db.prepare('INSERT INTO poster_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, artwork = excluded.artwork, artworkAt = excluded.artworkAt, touchedAt = excluded.touchedAt');
  const saveArtwork = accounts.db.prepare('UPDATE poster_assets SET artwork = ?, artworkAt = ? WHERE id = ? AND artwork = ?');
  const cache = new Map<string, Image>();
  const flights = new Map<string, Flight>();
  /** Poster id -> artwork fingerprint whose upstream lookup recently failed; new artwork for the title retries at once. */
  const resolveFailures = new Map<string, { fingerprint: string; until: number }>();
  const controllers = new Set<AbortController>();
  const queue: (() => void)[] = [];
  let active = 0;
  let cacheBytes = 0;
  let generation = 0;
  let closed = false;
  let lastPrune = 0;
  const configuredDiskMb = Number(process.env.POSTER_CACHE_MAX_MB || 2048);
  const diskMaxBytes = (Number.isFinite(configuredDiskMb) ? Math.max(128, configuredDiskMb) : 2048) * 1024 * 1024;
  const configuredDiskDays = Number(process.env.POSTER_CACHE_MAX_AGE_DAYS || 90);
  const diskLifetime = (Number.isFinite(configuredDiskDays) ? Math.max(7, configuredDiskDays) : 90) * 24 * 60 * 60 * 1000;
  const diskDirectory = join(accounts.directory, 'posters');
  mkdirSync(diskDirectory, { recursive: true, mode: 0o700 });
  let lastDiskPrune = 0;
  let diskPrune: Promise<void> | undefined;
  const diskPath = (id: string) => join(diskDirectory, id);
  async function removeDisk(id: string): Promise<void> {
    await unlink(diskPath(id)).catch(() => undefined);
  }
  async function readDisk(row: PosterRow, flight: Flight): Promise<Image | undefined> {
    try {
      const path = diskPath(row.id);
      const info = await stat(path);
      if (!info.isFile() || info.size > maxImageBytes + 128) throw new Error('封面缓存文件无效');
      const stored = await readFile(path);
      const expected = fingerprint(row.artwork);
      if (stored.subarray(0, diskMagic.length).toString() !== diskMagic || stored.subarray(diskMagic.length, diskMagic.length + 64).toString() !== expected || stored[diskMagic.length + 64] !== 10) {
        throw new Error('封面缓存标识已过期');
      }
      const typeStart = diskMagic.length + 65;
      const typeEnd = stored.indexOf(10, typeStart);
      if (typeEnd < typeStart || typeEnd - typeStart > 32) throw new Error('封面缓存类型无效');
      const type = stored.toString('ascii', typeStart, typeEnd);
      const bytes = stored.subarray(typeEnd + 1);
      if (bytes.length > maxImageBytes || rasterType(bytes) !== type) throw new Error('封面缓存内容无效');
      current(row, flight);
      return { bytes, type, fingerprint: expected, expires: Date.now() + cacheLifetime };
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      await removeDisk(row.id);
      return undefined;
    }
  }
  async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.write(bytes, offset, bytes.length - offset);
      if (result.bytesWritten === 0) throw new Error('无法写入封面缓存');
      offset += result.bytesWritten;
    }
  }
  async function writeDisk(row: PosterRow, flight: Flight, image: Image): Promise<void> {
    const temporary = join(diskDirectory, `.${row.id}.${randomUUID()}.tmp`);
    let file: FileHandle | undefined;
    try {
      file = await open(temporary, 'wx', 0o600);
      await writeAll(file, Buffer.from(`${diskMagic}${image.fingerprint}\n${image.type}\n`));
      await writeAll(file, image.bytes);
      await file.close();
      file = undefined;
      current(row, flight);
      await rename(temporary, diskPath(row.id));
    } finally {
      await file?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
  async function pruneDisk(): Promise<void> {
    const now = Date.now();
    const valid = new Set((accounts.db.prepare('SELECT id FROM poster_assets WHERE backend = ? AND touchedAt >= ?').all(backendUrl, now - metadataLifetime) as { id: string }[]).map(row => row.id));
    const files: { path: string; size: number; modified: number }[] = [];
    for (const entry of await readdir(diskDirectory, { withFileTypes: true })) {
      const path = join(diskDirectory, entry.name);
      if (!entry.isFile()) { await unlink(path).catch(() => undefined); continue; }
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      if (/^\.[a-f0-9]{64}\..+\.tmp$/.test(entry.name)) {
        if (now - info.mtimeMs > 60 * 60 * 1000) await unlink(path).catch(() => undefined);
        continue;
      }
      if (!/^[a-f0-9]{64}$/.test(entry.name) || !valid.has(entry.name) || now - info.mtimeMs > diskLifetime) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      files.push({ path, size: info.size, modified: info.mtimeMs });
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.modified - b.modified)) {
      if (total <= diskMaxBytes) break;
      await unlink(file.path).catch(() => undefined);
      total -= file.size;
    }
  }
  function scheduleDiskPrune(): void {
    const now = Date.now();
    if (diskPrune || now - lastDiskPrune < 24 * 60 * 60 * 1000) return;
    lastDiskPrune = now;
    diskPrune = pruneDisk().catch(error => app.log.warn({ err: error }, 'Poster disk cache pruning failed')).finally(() => { diskPrune = undefined; });
  }
  scheduleDiskPrune();
  function invalidate(id: string): void {
    const image = cache.get(id);
    if (image) { cacheBytes -= image.bytes.length; cache.delete(id); }
  }
  function clear(): void {
    generation++;
    cache.clear();
    cacheBytes = 0;
    resolveFailures.clear();
    for (const controller of controllers) controller.abort();
    flights.clear();
  }
  function current(row: PosterRow, flight: Flight): PosterRow {
    if (closed || generation !== flight.generation || row.backend !== backendUrl || flight.controller.signal.aborted) throw new ConfigError('封面请求已失效', 409);
    const latest = getRow.get(row.id) as unknown as PosterRow | undefined;
    if (!latest || fingerprint(latest.artwork) !== flight.fingerprint) throw new ConfigError('封面已更新，请重新加载', 409);
    return latest;
  }
  async function acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ConfigError('封面请求已取消', 409);
    if (active < 8) { active++; return; }
    await new Promise<void>((resolve, reject) => {
      const start = () => { signal.removeEventListener('abort', abort); active++; resolve(); };
      const abort = () => { const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1); reject(new ConfigError('封面请求已取消', 409)); };
      signal.addEventListener('abort', abort, { once: true });
      queue.push(start);
    });
  }
  async function load(row: PosterRow, flight: Flight): Promise<Image> {
    // Cached bytes never queue behind upstream lookups; only the upstream work below takes a slot.
    const persisted = await readDisk(row, flight);
    if (persisted) return persisted;
    const failure = resolveFailures.get(row.id);
    if (failure && failure.fingerprint === flight.fingerprint && failure.until > Date.now()) throw new ConfigError('封面暂不可用', 502);
    await acquire(flight.controller.signal);
    try {
      current(row, flight);
      let artwork: PosterArtwork | undefined = row.artwork && Date.now() - row.artworkAt < artworkLifetime ? JSON.parse(row.artwork) as PosterArtwork : undefined;
      const attempted = new Set<string>();
      for (let round = 0; round < 2; round++) {
        if (!artwork || round === 1) {
          let resolved: PosterArtwork;
          try {
            resolved = await resolveArtwork(row.sourceId, row.link, row.title, round === 1);
          } catch (error) {
            if (!(error instanceof ConfigError) && generation === flight.generation) {
              if (resolveFailures.size >= 10000) for (const [id, entry] of resolveFailures) if (entry.until <= Date.now()) resolveFailures.delete(id);
              if (resolveFailures.size < 10000) resolveFailures.set(row.id, { fingerprint: flight.fingerprint, until: Date.now() + resolveFailureLifetime });
            }
            throw error;
          }
          current(row, flight);
          const serialized = normalizeArtwork(resolved);
          saveArtwork.run(serialized, Date.now(), row.id, row.artwork);
          row.artwork = serialized;
          flight.fingerprint = fingerprint(serialized);
          artwork = JSON.parse(serialized) as PosterArtwork;
          invalidate(row.id);
        }
        for (const candidate of [artwork.url, ...(artwork.fallbackUrls || [])]) {
          if (!candidate) continue;
          const attemptKey = JSON.stringify([candidate, artwork.headers]);
          if (attempted.has(attemptKey)) continue;
          attempted.add(attemptKey);
          current(row, flight);
          try {
            const response = await safeBinaryRequest(new URL(candidate, row.backend).href, {
              headers: { accept: 'image/jpeg,image/png,image/webp,image/gif', ...artwork.headers },
              signal: flight.controller.signal, timeout: 10000, maxBytes: maxImageBytes, redirects: 3,
              allowBackend: true, validateUrl: url => validateArtworkUrl(url, row),
            });
            if (!response.ok || response.status === 204 || response.status === 206) throw new Error('上游封面不可用');
            const image: Image = { bytes: response.data, type: rasterType(response.data), fingerprint: flight.fingerprint, expires: Date.now() + cacheLifetime };
            current(row, flight);
            try {
              await writeDisk(row, flight, image);
              scheduleDiskPrune();
            } catch (error) {
              if (error instanceof ConfigError) throw error;
              app.log.warn({ err: error, posterId: row.id }, 'Poster disk cache write failed');
            }
            return image;
          } catch (error) {
            if (error instanceof ConfigError) throw error;
            current(row, flight);
          }
        }
      }
      throw new ConfigError('封面暂不可用', 502);
    } finally { active--; queue.shift()?.(); }
  }
  function imageFor(row: PosterRow): Promise<Image> {
    const identity = fingerprint(row.artwork);
    const cached = cache.get(row.id);
    if (cached && cached.fingerprint === identity && cached.expires > Date.now()) {
      cache.delete(row.id); cache.set(row.id, cached);
      return Promise.resolve(cached);
    }
    invalidate(row.id);
    const pending = flights.get(row.id);
    if (pending && pending.fingerprint === identity) return pending.promise;
    if (controllers.size >= 64) throw new ConfigError('封面请求过多，请稍后重试', 503);
    const controller = new AbortController();
    controllers.add(controller);
    const flight: Flight = { controller, fingerprint: identity, generation, promise: undefined! };
    const timer = setTimeout(() => controller.abort(), 30000);
    timer.unref();
    // Slots remain occupied until a resolver really settles, even after the HTTP caller times out.
    const work = load(row, flight).then(image => {
      current(row, flight);
      invalidate(row.id);
      resolveFailures.delete(row.id);
      while (cache.size >= 256 || cacheBytes + image.bytes.length > maxCacheBytes) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        invalidate(oldest);
      }
      cache.set(row.id, image);
      cacheBytes += image.bytes.length;
      return image;
    }).finally(() => {
      clearTimeout(timer);
      controllers.delete(controller);
      if (flights.get(row.id) === flight) flights.delete(row.id);
    });
    let abort: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ConfigError('封面请求超时或已取消', 504));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    flight.promise = Promise.race([work, aborted]).finally(() => controller.signal.removeEventListener('abort', abort));
    flights.set(row.id, flight);
    return flight.promise;
  }
  function decorate<T extends { sourceId: string; link: string; title: string; posterUrl: string }>(item: T, trustedArtwork?: PosterArtwork): T {
    if (!isKnownSource(item.sourceId) || !item.link || item.link.length > 8192) return { ...item, posterUrl: '' };
    const id = posterId(backendUrl, item.sourceId, item.link);
    const old = getRow.get(id) as unknown as PosterRow | undefined;
    const now = Date.now();
    const artwork = trustedArtwork === undefined ? old?.artwork || '' : normalizeArtwork(trustedArtwork);
    const title = item.title.slice(0, 2048);
    if (!old || old.artwork !== artwork || old.title !== title || now - old.touchedAt > 24 * 60 * 60 * 1000) {
      putRow.run(id, backendUrl, item.sourceId, item.link, title, artwork, old?.artwork === artwork ? old.artworkAt : now, now);
      if (old?.artwork !== artwork) {
        invalidate(id);
        flights.get(id)?.controller.abort();
        flights.delete(id);
      }
    }
    if (now - lastPrune > 60000) {
      lastPrune = now;
      accounts.db.prepare('DELETE FROM poster_assets WHERE touchedAt < ?').run(now - metadataLifetime);
      accounts.db.prepare('DELETE FROM poster_assets WHERE id IN (SELECT id FROM poster_assets ORDER BY touchedAt DESC LIMIT -1 OFFSET 250000)').run();
    }
    return { ...item, posterUrl: `/api/posters/${id}` };
  }
  /** `anonymous` is only for callers that already verified the id as a capability (the Emby image tag). */
  async function serve(request: FastifyRequest, reply: FastifyReply, id: string, cacheControl = 'private, no-store', anonymous = false) {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    if (!anonymous && !request.account) throw new ConfigError('请先登录', 401);
    const row = /^[a-f0-9]{64}$/.test(id) ? getRow.get(id) as unknown as PosterRow | undefined : undefined;
    if (!row || row.backend !== backendUrl || !backendUrl) throw new ConfigError('封面不存在或已失效', 404);
    if (request.account && !canAccessSource(request.account, row.sourceId)) throw new ConfigError('无权访问此视频源', 403);
    const requestGeneration = generation;
    const image = await imageFor(row);
    if (!anonymous) {
      const account = accounts.session(request) || accounts.embySession(request);
      if (!account) throw new ConfigError('请先登录', 401);
      if (account.id !== request.account!.id || !canAccessSource(account, row.sourceId)) throw new ConfigError('无权访问此视频源', 403);
    }
    const latest = getRow.get(row.id) as unknown as PosterRow | undefined;
    if (closed || requestGeneration !== generation || row.backend !== backendUrl || !latest || fingerprint(latest.artwork) !== image.fingerprint) throw new ConfigError('封面请求已失效', 409);
    return reply.header('Cache-Control', cacheControl).type(image.type).send(image.bytes);
  }
  async function prefetch(posterUrl: string): Promise<void> {
    const id = posterUrl.match(/^\/api\/posters\/([a-f0-9]{64})$/)?.[1];
    if (!id) return;
    const row = getRow.get(id) as unknown as PosterRow | undefined;
    if (!row || row.backend !== backendUrl || !backendUrl) return;
    await imageFor(row);
  }
  /**
   * Re-home rows saved under an earlier backend onto the current one, keeping their verified disk cache.
   * Tens of thousands of rows and files move in short batches so requests keep being served meanwhile;
   * `stopped` ends the run early when the backend changes again.
   */
  async function migrateBackend(rebase: (sourceId: string, link: string) => string, stopped: () => boolean = () => false): Promise<number> {
    if (!backendUrl) return 0;
    const target = backendUrl;
    const stale = accounts.db.prepare('SELECT * FROM poster_assets WHERE backend <> ?').all(target) as unknown as PosterRow[];
    const remove = accounts.db.prepare('DELETE FROM poster_assets WHERE id = ?');
    let moved = 0;
    for (let start = 0; start < stale.length; start += migrateBatchRows) {
      if (stopped() || target !== backendUrl) break;
      const moves: [string, string | undefined][] = [];
      accounts.transaction(() => {
        for (const row of stale.slice(start, start + migrateBatchRows)) {
          const link = rebase(row.sourceId, row.link);
          const id = posterId(target, row.sourceId, link);
          const keep = !getRow.get(id);
          if (keep) putRow.run(id, target, row.sourceId, link, row.title, row.artwork, row.artworkAt, row.touchedAt);
          remove.run(row.id);
          moves.push([row.id, keep ? id : undefined]);
        }
      });
      await Promise.all(moves.map(([from, to]) => (to ? rename(diskPath(from), diskPath(to)) : unlink(diskPath(from))).catch(() => { /* never cached */ })));
      moved += moves.length;
    }
    if (moved) clear();
    return moved;
  }
  /** Whether rows saved under an earlier backend are waiting for `migrateBackend`. */
  function hasForeignRows(): boolean {
    return !!backendUrl && !!accounts.db.prepare('SELECT 1 FROM poster_assets WHERE backend <> ? LIMIT 1').get(backendUrl);
  }
  app.get<{ Params: { id: string } }>('/api/posters/:id', async (request, reply) => serve(request, reply, request.params.id));
  app.addHook('onClose', async () => { closed = true; clear(); });
  return { decorate, clear, serve, prefetch, migrateBackend, hasForeignRows };
}
