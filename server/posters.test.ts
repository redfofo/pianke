import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import type { PosterArtwork } from './posters.js';

// A complete baseline grayscale 8x8 JPEG: one DC-zero block, EOB, and legal entropy padding.
const jpeg = Buffer.concat([
  Buffer.from('ffd8ffdb004300', 'hex'), Buffer.alloc(64, 1),
  Buffer.from('ffc0000b080008000801011100ffc400140001', 'hex'), Buffer.alloc(15), Buffer.from([0]),
  Buffer.from('ffc400141001', 'hex'), Buffer.alloc(15), Buffer.from([0]),
  Buffer.from('ffda0008010100003f003fffd9', 'hex'),
]);
function pngChunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', Buffer.from('00000001000000010802000000', 'hex')),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 128, 128, 128]))), pngChunk('IEND', Buffer.alloc(0)),
]);

test('authenticated same-origin posters persist, validate bytes and constrain every upstream hop', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'short-posters-'));
  const previous = { DATA_DIR: process.env.DATA_DIR, CAPY_BACKEND_URL: process.env.CAPY_BACKEND_URL, UPSTREAM_DOH_URL: process.env.UPSTREAM_DOH_URL };
  const requests: { path: string; headers: IncomingHttpHeaders }[] = [];
  let origin = '';
  let intermittent = false;
  let paddedJpeg: Buffer | undefined;
  let gate: { started: () => void; wait: Promise<void> } | undefined;
  const upstream = http.createServer(async (request, response) => {
    const url = new URL(request.url!, origin);
    requests.push({ path: request.url!, headers: request.headers });
    if (url.searchParams.get('kind') === 'cache-large' && paddedJpeg) { response.end(paddedJpeg); return; }
    const kind = url.searchParams.get('kind');
    if (kind === 'slow' && gate) { gate.started(); await gate.wait; }
    if (kind === 'redirect-other') { response.writeHead(302, { location: '/admin/private' }); response.end(); return; }
    if (kind === 'redirect-source') { response.writeHead(302, { location: '/api/v1/providers/dsd/cover' }); response.end(); return; }
    if (kind === 'redirect-private') { response.writeHead(302, { location: 'http://127.0.0.2/private' }); response.end(); return; }
    if (kind === 'redirect-nested') { response.writeHead(302, { location: '/api/v1/providers/hongguo/cover?url=http%3A%2F%2F127.0.0.1%2Fprivate' }); response.end(); return; }
    if (kind === 'redirect-good') { response.writeHead(302, { location: '/api/v1/providers/hongguo/cover?kind=jpeg' }); response.end(); return; }
    response.setHeader('content-type', 'image/jpeg');
    if (kind === 'missing' || (kind === 'intermittent' && !intermittent)) { response.statusCode = 404; response.end(jpeg); return; }
    if (kind === 'html') { response.end('<!doctype html><html><body>upstream challenge</body></html>'); return; }
    if (kind === 'svg') { response.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'); return; }
    if (kind === 'truncated') { response.end(jpeg.subarray(0, -2)); return; }
    if (kind === 'jpeg-padding') { response.end(Buffer.concat([jpeg, Buffer.from('\r\r\r\n\0')])); return; }
    if (kind === 'jpeg-payload') { response.end(Buffer.concat([jpeg, Buffer.from('<html>not padding</html>')])); return; }
    if (kind === 'large' || kind === 'compressed-large') {
      const bytes = Buffer.alloc(8 * 1024 * 1024 + 1);
      if (kind === 'compressed-large') { response.setHeader('content-encoding', 'gzip'); response.end(gzipSync(bytes)); }
      else response.end(bytes);
      return;
    }
    if (kind === 'gzip') { response.setHeader('content-encoding', 'gzip'); response.end(gzipSync(jpeg)); return; }
    if (kind === 'png') { response.setHeader('content-type', 'text/html'); response.end(png); return; }
    response.setHeader('content-type', 'application/octet-stream');
    response.end(jpeg);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  process.env.DATA_DIR = directory;
  process.env.CAPY_BACKEND_URL = origin;
  delete process.env.UPSTREAM_DOH_URL;
  // Config must observe the isolated backend before any runtime imports.
  const { AccountDatabase, registerAccountRoutes } = await import('./accounts.js');
  const { createPosterService } = await import('./posters.js');
  const { saveBackendUrl } = await import('./config.js');
  const { safeBinaryRequest } = await import('./provider-network.js');
  const resolved: { source: string; link: string; title: string; refresh: boolean | undefined }[] = [];
  const artworkByLink = new Map<string, PosterArtwork | (() => Promise<PosterArtwork>)>();
  const open = () => {
    const app = Fastify();
    const accounts = new AccountDatabase(directory);
    registerAccountRoutes(app, accounts);
    const service = createPosterService(app, accounts, async (source, link, title, refresh) => {
      resolved.push({ source, link, title, refresh });
      const artwork = artworkByLink.get(link);
      return typeof artwork === 'function' ? artwork() : artwork || { url: '' };
    });
    return { app, accounts, service };
  };
  let instance = open();
  t.after(async () => {
    await instance.app.close();
    instance.accounts.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const allowed = await instance.accounts.createUser('allowed', 'poster-test-password', 'user', ['hongguo', 'huangguo']);
  const denied = await instance.accounts.createUser('denied', 'poster-test-password', 'user', ['dsd']);
  const session = (id: string) => {
    const token = randomBytes(32).toString('base64url');
    instance.accounts.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), id, Date.now() + 3600000);
    return { cookie: `short_session=${token}` };
  };
  let headers = session(allowed.id);
  const deniedHeaders = session(denied.id);
  const item = (link: string) => ({ sourceId: 'hongguo', link, title: 'fixture title', posterUrl: '' });
  const cover = (kind = 'jpeg') => `${origin}/api/v1/providers/hongguo/cover?kind=${kind}`;
  const get = (url: string, auth = headers) => instance.app.inject({ method: 'GET', url, headers: auth });

  await t.test('binary transport and raster response preserve JPEG bytes exactly', async () => {
    const binary = await safeBinaryRequest(cover(), { allowBackend: true });
    assert.deepEqual(binary.data, jpeg);
    const original = item(origin + '/api/v1/providers/hongguo/items/one');
    const decorated = instance.service.decorate(original, { url: cover(), headers: { Referer: 'https://source.example/', Cookie: 'never-store-me', Authorization: 'never-forward-me' } });
    assert.equal(original.posterUrl, '');
    assert.match(decorated.posterUrl, /^\/api\/posters\/[a-f0-9]{64}$/);
    const first = await get(decorated.posterUrl);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers['content-type'], 'image/jpeg');
    assert.equal(first.headers['cache-control'], 'private, no-store');
    assert.deepEqual(first.rawPayload, jpeg);
    const sent = requests.at(-1)!;
    assert.equal(sent.headers.referer, 'https://source.example/');
    assert.equal(sent.headers.cookie, undefined);
    assert.equal(sent.headers.authorization, undefined);
    const stored = instance.accounts.db.prepare('SELECT artwork FROM poster_assets WHERE link = ?').get(original.link);
    assert.ok(stored && !String(stored.artwork).includes('never-'));
    const count = requests.length;
    for (let index = 0; index < 4; index++) instance.service.decorate(original);
    assert.equal((await get(decorated.posterUrl)).statusCode, 200);
    assert.equal(requests.length, count, 'legacy library saves preserve the successful cache');
    assert.equal((await instance.app.inject(decorated.posterUrl)).statusCode, 401);
    assert.equal((await get(decorated.posterUrl, deniedHeaders)).statusCode, 403);
    assert.equal(requests.length, count, 'cache hits are still source-authorized');
    await instance.app.close();
    instance.accounts.close();
    instance = open();
    assert.equal(instance.service.decorate(original).posterUrl, decorated.posterUrl);
    const restarted = await get(decorated.posterUrl);
    assert.equal(restarted.statusCode, 200, restarted.body);
    assert.deepEqual(restarted.rawPayload, jpeg);
    assert.equal(requests.length, count, 'validated poster bytes survive app/database restart');
    assert.equal(resolved.length, 0, 'trusted artwork metadata survives app/database restart');
  });

  await t.test('JPEG CDN padding remains displayable without accepting trailing markup', async () => {
    const padded = instance.service.decorate(item('jpeg-padding'), { url: cover('jpeg-padding') }).posterUrl;
    const response = await get(padded);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.rawPayload, Buffer.concat([jpeg, Buffer.from('\r\r\r\n\0')]));
    const markup = instance.service.decorate(item('jpeg-payload'), { url: cover('jpeg-payload') }).posterUrl;
    assert.equal((await get(markup)).statusCode, 502);
  });

  await t.test('actual formats, statuses, compression and size limits override MIME claims', async () => {
    for (const kind of ['png', 'gzip', 'redirect-good']) {
      const url = instance.service.decorate(item(kind), { url: cover(kind) }).posterUrl;
      const response = await get(url);
      assert.equal(response.statusCode, 200, kind + response.body);
      assert.deepEqual(response.rawPayload, kind === 'png' ? png : jpeg);
      assert.equal(response.headers['content-type'], kind === 'png' ? 'image/png' : 'image/jpeg');
    }
    for (const kind of ['html', 'svg', 'missing', 'truncated', 'large', 'compressed-large']) {
      const url = instance.service.decorate(item(kind), { url: cover(kind) }).posterUrl;
      assert.equal((await get(url)).statusCode, 502, kind);
    }
  });

  await t.test('only source-specific backend covers and public nested targets are allowed', async () => {
    const unsafe = [
      origin + '/admin/private', origin + '/api/v1/providers/dsd/cover', origin + '/api/v1/huangguo/cover',
      'http://127.0.0.2/private', 'http://2130706433/private', 'http://[::ffff:127.0.0.1]/private',
      'file:///etc/passwd', 'data:image/jpeg;base64,AA==',
      cover() + '&url=' + encodeURIComponent('http://127.0.0.1/private'),
      cover() + '&url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data'),
      cover() + '&url=' + encodeURIComponent('http://8.8.8.8/image?url=http://127.0.0.1/private'),
      cover() + '&url=' + encodeURIComponent(origin + '/admin/private'),
    ];
    for (const [index, target] of unsafe.entries()) {
      const before = requests.length;
      const url = instance.service.decorate(item(`unsafe-${index}`), { url: target }).posterUrl;
      assert.equal((await get(url)).statusCode, 502, target);
      assert.equal(requests.length, before, 'unsafe target never reaches the backend');
    }
    for (const kind of ['redirect-other', 'redirect-source', 'redirect-private', 'redirect-nested']) {
      const before = requests.length;
      const url = instance.service.decorate(item(kind), { url: cover(kind) }).posterUrl;
      assert.equal((await get(url)).statusCode, 502, kind);
      assert.equal(requests.length, before + 1, 'redirect target is checked before connecting');
    }
    const legitimate = instance.service.decorate(item('public-nested'), { url: cover() + '&url=' + encodeURIComponent('https://8.8.8.8/image.jpg?auth_key=signed') });
    assert.equal((await get(legitimate.posterUrl)).statusCode, 200);
    const huangguo = instance.service.decorate({ ...item('huangguo-cover'), sourceId: 'huangguo' }, { url: origin + '/api/v1/huangguo/cover?url=https%3A%2F%2F8.8.8.8%2Fimage.jpg' });
    assert.equal((await get(huangguo.posterUrl)).statusCode, 200);
    const count = requests.length;
    assert.equal((await get('/api/posters/' + '0'.repeat(64) + '?url=' + encodeURIComponent(cover()))).statusCode, 404);
    assert.equal(requests.length, count, 'client query URLs cannot register artwork');
    assert.equal(instance.service.decorate({ ...item('bad-source'), sourceId: 'unknown' }, { url: cover() }).posterUrl, '');
  });

  await t.test('legacy records resolve by identity, trusted fallbacks and one signed-URL refresh recover', async () => {
    const legacy = { ...item(origin + '/api/v1/providers/hongguo/items/legacy'), posterUrl: origin + '/admin/private' };
    artworkByLink.set(legacy.link, { url: cover() });
    const before = resolved.length;
    assert.equal((await get(instance.service.decorate(legacy).posterUrl)).statusCode, 200);
    assert.deepEqual(resolved[before], { source: 'hongguo', link: legacy.link, title: legacy.title, refresh: false });
    assert.ok(!requests.some(request => request.path === '/admin/private'));
    const fallbackBefore = resolved.length;
    assert.equal((await get(instance.service.decorate(item('fallback'), { url: cover('missing'), fallbackUrls: [cover()] }).posterUrl)).statusCode, 200);
    assert.equal(resolved.length, fallbackBefore, 'trusted fallback avoids unnecessary provider refresh');
    artworkByLink.set('refresh', { url: cover('gzip') });
    const refreshBefore = resolved.length;
    assert.equal((await get(instance.service.decorate(item('refresh'), { url: cover('missing') }).posterUrl)).statusCode, 200);
    assert.equal(resolved.length, refreshBefore + 1);
    assert.equal(resolved.at(-1)!.refresh, true);
    artworkByLink.set('intermittent', { url: cover('intermittent') });
    const retryUrl = instance.service.decorate(item('intermittent'), { url: cover('intermittent') }).posterUrl;
    assert.equal((await get(retryUrl)).statusCode, 502);
    intermittent = true;
    assert.equal((await get(retryUrl)).statusCode, 200, 'failed fetches are not permanently cached');
    const failing = item(origin + '/api/v1/providers/hongguo/items/resolve-failure');
    artworkByLink.set(failing.link, async () => { throw new Error('Worker 详情超时'); });
    const failingUrl = instance.service.decorate(failing).posterUrl;
    const failingBefore = resolved.length;
    assert.ok((await get(failingUrl)).statusCode >= 500);
    assert.equal((await get(failingUrl)).statusCode, 502);
    assert.equal(resolved.length, failingBefore + 1, 'a failed upstream lookup is not repeated right away');
    assert.equal((await get(instance.service.decorate(failing, { url: cover() }).posterUrl)).statusCode, 200, 'new artwork retries at once');
    const changing = item('changing');
    const changingUrl = instance.service.decorate(changing, { url: cover() }).posterUrl;
    assert.equal((await get(changingUrl)).headers['content-type'], 'image/jpeg');
    assert.equal(instance.service.decorate(changing, { url: cover('png') }).posterUrl, changingUrl);
    assert.equal((await get(changingUrl)).headers['content-type'], 'image/png', 'artwork identity invalidates bytes without changing the durable route');
  });

  await t.test('concurrent requests share a fetch and revocation or logout wins over in-flight bytes', async () => {
    const start = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    gate = { started: start.resolve, wait: finish.promise };
    const url = instance.service.decorate(item('flight'), { url: cover('slow') }).posterUrl;
    const count = requests.length;
    const first = get(url);
    const second = get(url);
    const results = Promise.all([first, second]);
    await start.promise;
    instance.accounts.db.prepare('UPDATE users SET sourceIds = ? WHERE id = ?').run('[]', allowed.id);
    finish.resolve();
    assert.deepEqual((await results).map(result => result.statusCode), [403, 403]);
    assert.equal(requests.length, count + 1, 'single-flight avoids duplicate upstream bytes');
    assert.equal((await get(url)).statusCode, 403, 'revocation also blocks populated cache');
    instance.accounts.db.prepare('UPDATE users SET sourceIds = ? WHERE id = ?').run('["hongguo","huangguo"]', allowed.id);
    const logoutStart = Promise.withResolvers<void>();
    const logoutFinish = Promise.withResolvers<void>();
    gate = { started: logoutStart.resolve, wait: logoutFinish.promise };
    const pending = get(instance.service.decorate(item('logout-flight'), { url: cover('slow') }).posterUrl).then(value => value);
    await logoutStart.promise;
    instance.accounts.db.prepare('DELETE FROM sessions WHERE userId = ?').run(allowed.id);
    logoutFinish.resolve();
    assert.equal((await pending).statusCode, 401);
    headers = session(allowed.id);
    gate = undefined;
  });

  await t.test('single-flight admission and actual resolver concurrency are bounded', async () => {
    const release = Promise.withResolvers<void>();
    const saturated = Promise.withResolvers<void>();
    let resolving = 0;
    let peak = 0;
    const pending = Array.from({ length: 70 }, (_, index) => {
      const link = `bounded-${index}`;
      artworkByLink.set(link, async () => {
        peak = Math.max(peak, ++resolving);
        if (peak === 8) saturated.resolve();
        await release.promise;
        resolving--;
        return { url: cover() };
      });
      return get(instance.service.decorate(item(link)).posterUrl).then(response => response.statusCode);
    });
    try {
      assert.deepEqual(await Promise.all(pending.slice(64)), Array(6).fill(503));
      await saturated.promise;
      assert.equal(peak, 8);
    } finally { release.resolve(); }
    assert.deepEqual(await Promise.all(pending.slice(0, 64)), Array(64).fill(200));
    assert.equal(peak, 8);
  });

  await t.test('memory evictions fall through to the persistent cache without upstream requests', async () => {
    const first = instance.service.decorate(item('cache-entry-0'), { url: cover() }).posterUrl;
    for (let index = 0; index < 257; index++) {
      const url = instance.service.decorate(item(`cache-entry-${index}`), { url: cover() }).posterUrl;
      assert.equal((await get(url)).statusCode, 200);
    }
    const before = requests.length;
    assert.equal((await get(first)).statusCode, 200);
    assert.equal(requests.length, before, 'oldest memory entry remains available on disk');
    const segment = Buffer.alloc(65537);
    segment.writeUInt32BE(0xffe1ffff);
    paddedJpeg = Buffer.concat([jpeg.subarray(0, 2), ...Array.from({ length: 112 }, () => segment), jpeg.subarray(2)]);
    const largeFirst = instance.service.decorate(item('cache-byte-0'), { url: cover('cache-large') }).posterUrl;
    for (let index = 0; index < 5; index++) {
      const url = instance.service.decorate(item(`cache-byte-${index}`), { url: cover('cache-large') }).posterUrl;
      const response = await get(url);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.rawPayload, paddedJpeg);
    }
    const byteCount = requests.length;
    assert.equal((await get(largeFirst)).statusCode, 200);
    assert.equal(requests.length, byteCount, 'byte-capacity eviction remains available on disk');
    paddedJpeg = undefined;
  });

  await t.test('clear aborts in-flight requests and backend changes invalidate durable old routes', async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<PosterArtwork>();
    artworkByLink.set('clear-flight', async () => { started.resolve(); return finish.promise; });
    const old = instance.service.decorate(item('clear-flight')).posterUrl;
    const pending = get(old).then(value => value);
    await started.promise;
    instance.service.clear();
    finish.resolve({ url: cover() });
    assert.notEqual((await pending).statusCode, 200);
    artworkByLink.set('clear-flight', { url: cover() });
    assert.equal((await get(old)).statusCode, 200, 'clear does not erase identity metadata');
    const count = requests.length;
    await saveBackendUrl('http://127.0.0.1:1', instance.service.clear);
    assert.equal((await get(old)).statusCode, 404);
    assert.notEqual(instance.service.decorate(item('clear-flight')).posterUrl, old);
    assert.equal(requests.length, count);
    await saveBackendUrl(origin, instance.service.clear);
    assert.equal(instance.service.decorate(item('clear-flight')).posterUrl, old);
  });
});
