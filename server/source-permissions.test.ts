import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { InjectOptions } from 'fastify';
import { sourceIds } from '../src/source-catalog.js';
import { episodeKey, recordKey } from '../src/storage.js';

const password = 'source-permissions-password';

test('source grants migrate, persist, isolate accounts and revoke library and nested media access immediately', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'short-permissions-'));
  const previous = { DATA_DIR: process.env.DATA_DIR, CAPY_BACKEND_URL: process.env.CAPY_BACKEND_URL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const upstreamRequests: string[] = [];
  const upstream = http.createServer((request, response) => {
    const path = request.url!;
    upstreamRequests.push(path);
    if (path === '/api/v1/components') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ components: sourceIds.map(id => ({ id, enabled: true })) }));
    }
    if (path.startsWith('/widgets/')) return response.end("var WidgetMetadata = { title: '测试源', modules: [{ id: 'hot', title: '热门', functionName: 'getList', params: [] }] };");
    if (path.endsWith('master.m3u8')) {
      response.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return response.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Chinese",URI="subtitles.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nvariant.m3u8\n');
    }
    if (path.endsWith('subtitles.m3u8')) {
      response.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return response.end('#EXTM3U\n#EXTINF:6,\nsubtitle.vtt\n');
    }
    if (path.endsWith('variant.m3u8')) {
      response.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return response.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment.ts\n');
    }
    response.setHeader('content-type', path.endsWith('.vtt') ? 'text/vtt' : 'application/octet-stream');
    response.end(path.endsWith('.vtt') ? 'WEBVTT\n' : 'media bytes');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const backend = `http://127.0.0.1:${address.port}`;
  process.env.DATA_DIR = directory;
  process.env.CAPY_BACKEND_URL = backend;
  delete process.env.ADMIN_PASSWORD;

  // A real pre-permissions database, including a session issued before migration.
  const legacy = new DatabaseSync(join(directory, 'accounts.sqlite'));
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK(role IN ('admin','user')), createdAt INTEGER NOT NULL,
      salt TEXT NOT NULL, passwordHash TEXT NOT NULL);
    CREATE TABLE sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expiresAt INTEGER NOT NULL);
  `);
  const salt = randomBytes(32).toString('hex');
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  for (const [id, role] of [['admin', 'admin'], ['legacy', 'user']]) legacy.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(id!, id!, role!, Date.now(), salt, hash);
  const oldToken = randomBytes(32).toString('base64url');
  legacy.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(oldToken).digest('hex'), 'legacy', Date.now() + 3600000);
  legacy.close();

  // Config reads environment at module initialization, so import only after the isolated upstream is listening.
  const { createApp } = await import('./index.js');
  const { preparePlayback } = await import('./media.js');
  let app = await createApp();
  t.after(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const call = (headers: Record<string, string>, url: string, payload?: InjectOptions['payload']) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers, payload });
  const login = async (username: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(Array.isArray(response.json().user.sourceIds), 'login exposes the current source selection');
    return { cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-account-id': response.json().user.id as string };
  };
  const admin = await login('admin');
  const old = { cookie: `short_session=${oldToken}`, 'x-account-id': 'legacy' };
  assert.deepEqual((await call(old, '/api/auth/me')).json().user.sourceIds, sourceIds);
  assert.deepEqual((await call(admin, '/api/auth/me')).json().user.sourceIds, sourceIds);
  assert.deepEqual((await call(admin, '/api/admin/users')).json().users.map((user: { sourceIds: string[] }) => user.sourceIds), [sourceIds, sourceIds]);

  for (const value of [null, 'hongguo', {}, ['missing'], [1], ['hongguo', null]]) {
    assert.equal((await call(admin, '/api/admin/users', { username: 'invalid', password, sourceIds: value })).statusCode, 400);
    assert.equal((await call(admin, '/api/admin/users/legacy/sources', { sourceIds: value })).statusCode, 400);
  }
  assert.equal((await call(admin, '/api/admin/users/legacy/sources', {})).statusCode, 400);
  assert.equal((await call(admin, '/api/admin/users/missing/sources', { sourceIds: [] })).statusCode, 404);
  assert.equal((await call(admin, '/api/admin/users/admin/sources', { sourceIds: [] })).statusCode, 403);
  const created = await call(admin, '/api/admin/users', { username: 'alice', password, sourceIds: ['hongguo', 'hongguo'] });
  assert.deepEqual(created.json().user.sourceIds, ['hongguo']);
  const alice = await login('alice');
  const aliceSources = `/api/admin/users/${alice['x-account-id']}/sources`;
  assert.deepEqual((await call(alice, '/api/auth/me')).json().user.sourceIds, ['hongguo']);
  assert.equal((await call(alice, aliceSources, { sourceIds })).statusCode, 403);
  const compatible = await call(admin, '/api/admin/users', { username: 'compatible', password });
  assert.deepEqual(compatible.json().user.sourceIds, sourceIds);
  const emptyUser = await call(admin, '/api/admin/users', { username: 'empty', password, sourceIds: [] });
  assert.deepEqual(emptyUser.json().user.sourceIds, []);

  upstreamRequests.length = 0;
  assert.deepEqual((await call(alice, '/api/sources')).json().map((source: { id: string }) => source.id), ['hongguo']);
  assert.deepEqual(upstreamRequests.filter(path => path.startsWith('/widgets/')), ['/widgets/hongguo.js']);
  assert.deepEqual(Object.keys((await call(alice, '/api/status')).json().sources), ['hongguo']);
  const deniedRoutes: [string, InjectOptions['payload']?][] = [
    ['/browse'], ['/search?q=test'], ['/detail?link=one'],
    ['/playback', { link: 'one', episodeId: 'one' }],
    ['/playback', { link: 'one', episodeId: 'one', serverProxy: false }],
    ['/playback-report', { ok: true, message: 'forged' }], ['/check', {}],
  ];
  const count = upstreamRequests.length;
  for (const [route, payload] of deniedRoutes) assert.equal((await call(alice, '/api/sources/dsd' + route, payload)).statusCode, 403, route);
  assert.equal(upstreamRequests.length, count, 'denied source routes never reach upstream');
  assert.equal((await call(alice, '/api/sources/hongguo/playback-report', { ok: true, message: 'allowed' })).statusCode, 200);

  const media = { sourceId: 'hongguo', mediaId: 'one', link: '/one', title: 'preserved', posterUrl: '' };
  const watch = { ...media, episodeId: 'episode1', episodeTitle: 'first', position: 21, duration: 120 };
  const watchUrl = '/api/library/watch?' + new URLSearchParams({ key: episodeKey('hongguo', '/one', 'episode1') });
  assert.equal((await call(alice, '/api/library/watch', watch)).statusCode, 200);
  assert.equal((await call(alice, '/api/library/favorite', { record: media })).statusCode, 200);
  const scope = { userId: alice['x-account-id'], sourceId: 'hongguo' };
  const candidate = { url: backend + '/api/v1/stream/master.m3u8', headers: {}, title: 'test' };
  const root = (await preparePlayback(candidate, scope)).src;
  const otherOwner = (await preparePlayback(candidate, { ...scope, userId: 'legacy' })).src;
  const otherSource = (await preparePlayback(candidate, { ...scope, sourceId: 'dsd' })).src;
  assert.notEqual(root, otherOwner);
  assert.notEqual(root, otherSource);
  const deniedCount = upstreamRequests.length;
  assert.equal((await call(old, root)).statusCode, 403, 'an authorized account cannot borrow another account media token');
  assert.equal((await call(admin, root)).statusCode, 403, 'admin still needs its own media grant');
  assert.equal((await call(alice, otherSource)).statusCode, 403, 'tokens are scoped to the source, not just the owner');
  assert.equal(upstreamRequests.length, deniedCount);
  const mediaUrls = [root];
  for (let index = 0; index < mediaUrls.length; index++) {
    const response = await call(alice, mediaUrls[index]!);
    assert.equal(response.statusCode, 200, response.body);
    if (response.body.startsWith('#EXTM3U')) {
      const children = [...response.body.matchAll(/URI="([^"]+)"/g)].map(match => match[1]!);
      children.push(...response.body.split('\n').filter(line => line && !line.startsWith('#')));
      for (const child of children) {
        assert.match(child, /^\/api\/media\/[\w-]+$/);
        if (!mediaUrls.includes(child)) mediaUrls.push(child);
      }
    }
  }
  assert.equal(mediaUrls.length, 7, 'master, variant, subtitle playlist, key, init, segment and subtitle are all scoped');
  const nestedCount = upstreamRequests.length;
  for (const url of mediaUrls) assert.equal((await call(old, url)).statusCode, 403);
  assert.equal(upstreamRequests.length, nestedCount);

  assert.deepEqual((await call(admin, aliceSources, { sourceIds: ['dsd', 'huangdou', 'dsd'] })).json().user.sourceIds, ['dsd', 'huangdou']);
  assert.deepEqual((await call(alice, '/api/auth/me')).json().user.sourceIds, ['dsd', 'huangdou']);
  assert.deepEqual((await call(alice, '/api/sources')).json().map((source: { id: string }) => source.id), ['dsd', 'huangdou']);
  assert.deepEqual(Object.keys((await call(alice, '/api/status')).json().sources), ['dsd', 'huangdou']);
  assert.deepEqual((await call(alice, '/api/library')).json(), { favorites: [], recent: [] });
  assert.equal((await call(alice, watchUrl)).statusCode, 403);
  const partiallyRevokedCount = upstreamRequests.length;
  for (const url of mediaUrls) assert.equal((await call(alice, url)).statusCode, 403, 'removing just this source revokes every child grant');
  assert.equal(upstreamRequests.length, partiallyRevokedCount);
  assert.equal((await call(alice, '/api/library/watch', watch)).statusCode, 403);
  assert.equal((await call(alice, '/api/library/favorite', { record: media })).statusCode, 403);
  for (const kind of ['history', 'favorites']) {
    assert.equal((await call(alice, '/api/library/remove', { kind, key: recordKey('hongguo', '/one') })).statusCode, 403);
    assert.equal((await call(alice, '/api/library/clear', { kind })).statusCode, 200, 'clear only affects accessible records');
  }
  assert.equal((await call(admin, aliceSources, { sourceIds: [] })).statusCode, 200);
  const revokedCount = upstreamRequests.length;
  assert.deepEqual((await call(alice, '/api/sources')).json(), []);
  assert.deepEqual((await call(alice, '/api/status')).json().sources, {});
  for (const url of mediaUrls) assert.equal((await call(alice, url)).statusCode, 403);
  assert.equal((await app.inject({ method: 'HEAD', url: root, headers: alice })).statusCode, 403);
  for (const [route, payload] of deniedRoutes) assert.equal((await call(alice, '/api/sources/hongguo' + route, payload)).statusCode, 403);
  assert.equal(upstreamRequests.length, revokedCount, 'revoked media and source routes are blocked before any fetch');
  assert.equal((await call(admin, '/api/sources')).json().length, sourceIds.length);
  assert.equal((await call(admin, `/api/admin/users/${compatible.json().user.id}/sources`, { sourceIds: ['dsd', 'huangdou'] })).statusCode, 200);

  await app.close();
  app = await createApp();
  assert.deepEqual((await call(alice, '/api/auth/me')).json().user.sourceIds, [], 'empty permissions and existing session survive restart');
  assert.deepEqual((await call(old, '/api/auth/me')).json().user.sourceIds, sourceIds, 'old-schema permissions persist after reopening');
  assert.deepEqual((await call(admin, '/api/admin/users')).json().users.find((user: { id: string }) => user.id === compatible.json().user.id).sourceIds, ['dsd', 'huangdou'], 'multiple selected permissions survive reopening');
  assert.deepEqual((await call(admin, aliceSources, { sourceIds })).json().user.sourceIds, sourceIds);
  assert.equal((await call(alice, watchUrl)).json().watch.position, 21);
  const restored = (await call(alice, '/api/library')).json();
  assert.equal(restored.favorites[0].title, media.title);
  assert.equal(restored.recent[0].position, 21);
  assert.equal((await call(alice, root)).statusCode, 200, 'regrant restores scoped media access');
  assert.deepEqual((await call(admin, '/api/admin/users')).json().users.find((user: { id: string }) => user.id === alice['x-account-id']).sourceIds, sourceIds);
});
