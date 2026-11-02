import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { episodeKey, recordKey } from '../src/storage.js';

const password = 'isolated-test-password';

test('accounts enforce provisioning, session boundaries and durable private libraries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'short-accounts-'));
  const env = { DATA_DIR: process.env.DATA_DIR, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, ADMIN_USERNAME: process.env.ADMIN_USERNAME, CAPY_BACKEND_URL: process.env.CAPY_BACKEND_URL, SESSION_COOKIE_SECURE: process.env.SESSION_COOKIE_SECURE };
  process.env.DATA_DIR = dir;
  process.env.CAPY_BACKEND_URL = '';
  process.env.ADMIN_USERNAME = 'admin';
  delete process.env.ADMIN_PASSWORD;
  delete process.env.SESSION_COOKIE_SECURE;
  const { createApp } = await import('./index.js');
  await assert.rejects(createApp(), /ADMIN_PASSWORD/);
  process.env.ADMIN_PASSWORD = password;
  let app = await createApp();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const login = async (username: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(String(response.headers['set-cookie']), /HttpOnly; SameSite=Lax/);
    return { cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-account-id': response.json().user.id as string };
  };
  const admin = await login('ADMIN');
  const call = (headers: Record<string, string>, url: string, payload?: InjectOptions['payload']) =>
    app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers, payload });

  for (const url of ['/api/library', '/api/admin/users', '/api/config', '/api/sources', '/api/media/unknown']) {
    assert.equal((await app.inject(url)).statusCode, 401, url);
  }
  assert.deepEqual((await app.inject('/api/auth/me')).json(), { user: null });
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  for (const username of ['alice', 'bobby']) {
    const created = await call(admin, '/api/admin/users', { username, password, role: 'admin' });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().user.role, 'user');
    assert.equal('passwordHash' in created.json().user, false);
  }
  assert.equal((await call(admin, '/api/admin/users', { username: 'ALICE', password })).statusCode, 409);
  assert.equal((await call(admin, '/api/admin/users', { username: 'tiny', password: 'short' })).statusCode, 400);
  const alice = await login('alice');
  const bob = await login('bobby');
  const publicInfo = await app.inject('/System/Info/Public');
  assert.equal(publicInfo.statusCode, 200, publicInfo.body);
  assert.equal(publicInfo.json().ProductName, '片刻媒体服务器');
  const embyLogin = await app.inject({
    method: 'POST',
    url: '/Users/AuthenticateByName',
    headers: { 'x-emby-authorization': 'MediaBrowser Client="Protocol Test", Device="Node", DeviceId="test-device", Version="1.0"' },
    payload: { Username: 'alice', Pw: password },
  });
  assert.equal(embyLogin.statusCode, 200, embyLogin.body);
  const embyToken = embyLogin.json().AccessToken as string;
  assert.match(embyToken, /^[A-Za-z0-9_-]{20,128}$/);
  const loginSession = embyLogin.json().SessionInfo;
  for (const field of ['Id', 'UserId', 'LastActivityDate', 'LastPlaybackCheckIn', 'ServerId', 'PlayableMediaTypes', 'SupportedCommands']) {
    assert.notEqual(loginSession[field], undefined, `missing SessionInfo.${field}`);
  }
  const lennaHeaders = { 'x-emby-authorization': `MediaBrowser Token="${embyToken}", Client="Lenna", Device="iPad", DeviceId="lenna-test", Version="1.0.16"` };
  assert.equal((await app.inject({ url: '/emby/Items/Counts', headers: lennaHeaders })).statusCode, 200);
  assert.equal((await app.inject({ url: '/emby/emby/Items/Counts', headers: lennaHeaders })).statusCode, 200, 'duplicated /emby prefixes are collapsed');
  const virtualFolders = await app.inject({ url: '/Library/VirtualFolders', headers: lennaHeaders });
  assert.equal(virtualFolders.statusCode, 200, virtualFolders.body);
  assert.match(String(virtualFolders.headers['content-type']), /^application\/json/);
  assert.equal(virtualFolders.json().length, 8);
  assert.ok(virtualFolders.json().every((folder: { ItemId?: string; CollectionType?: string }) => folder.ItemId && folder.CollectionType === 'tvshows'));
  const unknownEmbyRoute = await app.inject({ url: '/emby/Library/Unknown', headers: lennaHeaders });
  assert.equal(unknownEmbyRoute.statusCode, 404);
  assert.match(String(unknownEmbyRoute.headers['content-type']), /^application\/json/);
  const embyHeaders = { 'x-emby-token': embyToken };
  const views = await app.inject({ url: `/Users/${alice['x-account-id']}/Views`, headers: embyHeaders });
  assert.equal(views.statusCode, 200, views.body);
  assert.equal(views.json().TotalRecordCount, 8);
  assert.equal((await app.inject({ url: `/Users/${bob['x-account-id']}/Views`, headers: embyHeaders })).statusCode, 403);
  // SenPlayer style: lowercase paths, token in the X-Emby-Token query parameter.
  assert.equal((await app.inject('/emby/system/info/public')).statusCode, 200);
  const lowercase = await app.inject(`/emby/users/${alice['x-account-id']}/views?X-Emby-Token=${embyToken}`);
  assert.equal(lowercase.statusCode, 200, lowercase.body);
  assert.equal(lowercase.json().TotalRecordCount, 8);
  assert.equal((await app.inject(`/emby/users/${alice['x-account-id']}/views`)).statusCode, 401);
  assert.equal((await app.inject(`/emby/videos/${views.json().Items[0].Id}/stream?Static=true&ApiKey=${embyToken}`)).statusCode, 400);
  assert.equal((await app.inject(`/API/library`)).statusCode, 401);
  const nextUp = await app.inject({ url: `/emby/Shows/NextUp?UserId=${alice['x-account-id']}&Limit=20`, headers: embyHeaders });
  assert.equal(nextUp.statusCode, 200, nextUp.body);
  assert.deepEqual(nextUp.json(), { Items: [], TotalRecordCount: 0 });
  assert.equal((await app.inject({ url: `/emby/Shows/NextUp?UserId=${bob['x-account-id']}`, headers: embyHeaders })).statusCode, 403);
  assert.equal((await app.inject({ url: '/emby/Shows/NextUp?SeriesId=missing', headers: embyHeaders })).statusCode, 404);
  for (const path of ['Items', 'Shows', 'Movies']) {
    const similar = await app.inject({ url: `/emby/${path}/${views.json().Items[0].Id}/Similar`, headers: embyHeaders });
    assert.deepEqual([similar.statusCode, similar.json()], [200, { Items: [], TotalRecordCount: 0 }], path);
  }
  assert.equal((await app.inject(`/emby/Movies/${views.json().Items[0].Id}/Similar`)).statusCode, 401);
  // Image loaders send no token; artwork then needs the item's tag, so untagged or mistagged requests find nothing.
  assert.equal((await app.inject(`/emby/Items/${views.json().Items[0].Id}/Images/Primary`)).statusCode, 404);
  assert.equal((await app.inject(`/emby/Items/${views.json().Items[0].Id}/Images/Primary?tag=${'0'.repeat(64)}`)).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/emby/Items/${views.json().Items[0].Id}/Images/Primary` })).statusCode, 401);
  assert.equal((await app.inject(`/emby/Items/${views.json().Items[0].Id}/Images/Primary?api_key=${'x'.repeat(32)}`)).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/admin/emby/status', headers: embyHeaders })).statusCode, 403);
  for (const url of ['/api/admin/users', '/api/config']) {
    assert.equal((await call(alice, url)).statusCode, 403);
    assert.equal((await call(alice, url, { username: 'hacker', password, backendUrl: 'https://example.com' })).statusCode, 403);
  }
  assert.equal((await call({ ...alice, origin: 'https://evil.example' }, '/api/auth/logout', {})).statusCode, 403);
  assert.equal((await call({ ...bob, 'x-account-id': alice['x-account-id'] }, '/api/library/clear', { kind: 'history' })).statusCode, 409);
  assert.equal((await call({ cookie: alice.cookie }, '/api/library')).statusCode, 409);

  const media = { sourceId: 'hongguo', mediaId: 'one', link: '/drama/one', title: '独立记录', posterUrl: '' };
  const first = { ...media, key: 'forged', mediaKey: 'forged', episodeId: 'e1', episodeTitle: '第一集', position: 31, duration: 120, updatedAt: 1, userId: bob['x-account-id'] };
  const save = await call(alice, '/api/library/watch', first);
  assert.equal(save.statusCode, 200, save.body);
  assert.equal(save.json().watch.key, episodeKey('hongguo', media.link, 'e1'));
  assert.ok(save.json().watch.updatedAt > 1);
  const recursiveItems = await app.inject({ url: '/Items?Recursive=true&IncludeItemTypes=Series', headers: embyHeaders });
  assert.equal(recursiveItems.statusCode, 200, recursiveItems.body);
  assert.deepEqual(recursiveItems.json().Items.map((item: { Name: string }) => item.Name), [media.title]);
  await call(alice, '/api/library/watch', { ...first, episodeId: 'e2', position: 58 });
  assert.equal((await call(alice, '/api/status')).json().backendUrl, '');
  await call(bob, '/api/library/watch', { ...first, position: 7 });
  assert.deepEqual((await call(alice, '/api/library')).json().recent.map((row: { episodeId: string; position: number }) => [row.episodeId, row.position]), [['e2', 58]]);
  assert.deepEqual((await call(bob, '/api/library')).json().recent.map((row: { episodeId: string; position: number }) => [row.episodeId, row.position]), [['e1', 7]]);
  const watchPath = '/api/library/watch?' + new URLSearchParams({ key: episodeKey('hongguo', media.link, 'e2') });
  assert.equal((await call(bob, watchPath)).json().watch, null);
  assert.equal((await call(alice, watchPath)).json().watch.position, 58);
  assert.equal((await call(alice, '/api/library/watch', { ...first, position: -1 })).statusCode, 400);
  assert.equal((await call(alice, '/api/library/favorite', { record: { ...media, posterUrl: 'javascript:alert(1)' } })).statusCode, 400);
  assert.deepEqual((await call(alice, '/api/library/favorite', { record: media })).json(), { favorite: true });
  assert.deepEqual((await call(bob, '/api/library')).json().favorites, []);
  await call(bob, '/api/library/favorite', { record: media });
  await call(alice, '/api/library/clear', { kind: 'favorites' });
  assert.deepEqual((await call(alice, '/api/library')).json().favorites, []);
  assert.equal((await call(bob, '/api/library')).json().favorites[0].title, media.title);

  await call(alice, '/api/library/remove', { kind: 'history', key: recordKey('hongguo', media.link) });
  assert.deepEqual((await call(alice, '/api/library')).json().recent, []);
  assert.equal((await call(alice, watchPath)).json().watch, null);
  assert.equal((await call(bob, '/api/library')).json().recent[0].position, 7);
  await call(alice, '/api/library/watch', first);
  await call(alice, '/api/library/clear', { kind: 'history' });
  const firstPath = '/api/library/watch?' + new URLSearchParams({ key: episodeKey('hongguo', media.link, 'e1') });
  assert.equal((await call(alice, firstPath)).json().watch, null);
  assert.equal((await call(bob, firstPath)).json().watch.position, 7);

  await app.close();
  delete process.env.ADMIN_PASSWORD;
  app = await createApp();
  assert.equal((await call(bob, firstPath)).json().watch.position, 7, 'progress and session survive restart');
  assert.equal((await call(bob, '/api/library')).json().favorites[0].title, media.title);
  assert.equal((await app.inject({ url: `/Users/${alice['x-account-id']}`, headers: embyHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/Sessions/Logout', headers: embyHeaders })).statusCode, 200);
  assert.equal((await app.inject({ url: `/Users/${alice['x-account-id']}`, headers: embyHeaders })).statusCode, 401);
  await call(bob, '/api/library/remove', { kind: 'favorites', key: recordKey('hongguo', media.link) });
  assert.deepEqual((await call(bob, '/api/library')).json().favorites, []);
  assert.equal((await call(bob, '/api/auth/logout', {})).statusCode, 200);
  assert.equal((await call(bob, '/api/library')).statusCode, 401);
  assert.equal((await call(admin, '/api/admin/users')).json().users.length, 3);

  for (let index = 0; index < 10; index++) {
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '192.0.2.8', payload: { username: index % 2 ? 'missing' : 'alice', password: 'wrong-password' } });
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), { error: '账号或密码错误' });
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '192.0.2.8', payload: { username: 'alice', password } })).statusCode, 429);
  process.env.SESSION_COOKIE_SECURE = 'true';
  const secureLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password } });
  assert.match(String(secureLogin.headers['set-cookie']), /; Secure/);
});
