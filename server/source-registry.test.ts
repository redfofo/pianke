import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('components added upstream are browsable, grantable and remembered without a player release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'short-registry-'));
  const previous = { DATA_DIR: process.env.DATA_DIR, CAPY_BACKEND_URL: process.env.CAPY_BACKEND_URL };
  let components: { id: string; title?: string; enabled: boolean }[] = [{ id: 'hongguo', title: '上游改名', enabled: true }];
  const upstream = http.createServer((request, response) => {
    if (request.url === '/api/v1/components') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ components }));
    }
    if (request.url === '/widgets/acme-tv.js') {
      return response.end(`var WidgetMetadata = { title: 'Acme 影视', modules: [{ id: 'latest', title: '最新', functionName: 'loadLatest', params: [{ name: 'page', type: 'page' }] }] };
async function loadLatest(params) {
  const res = await Widget.http.get(CAPY_BACKEND_URL + '/api/v1/providers/acme-tv/list?page=' + params.page);
  return JSON.parse(res.data).map(row => ({ id: row.id, title: row.name, link: 'https://acme.example/v/' + row.id, posterUrl: '' }));
}
async function loadDetail(link) {
  await Widget.http.get(CAPY_BACKEND_URL + '/api/v1/subtitles/warmup').catch(() => {});
  return { title: 'one', videoUrl: 'https://acme.example/one.m3u8', link };
}`);
    }
    if (request.url === '/api/v1/providers/acme-tv/list?page=1') return response.end(JSON.stringify([{ id: '7', name: '第七号' }]));
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  process.env.DATA_DIR = dir;
  process.env.CAPY_BACKEND_URL = `http://127.0.0.1:${address.port}`;
  const { createAuthenticatedApp } = await import('./test-auth.js');
  const app = await createAuthenticatedApp();
  try {
    assert.equal((await app.inject('/api/sources/acme-tv/browse')).statusCode, 403, 'unknown before the upstream installs it');
    components = [...components, { id: 'acme-tv', title: 'Acme', enabled: true }, { id: '../bad', title: 'x', enabled: true }];
    const listed = (await app.inject('/api/sources')).json() as { id: string; title: string }[];
    assert.deepEqual(listed.map(source => source.id), ['hongguo', 'acme-tv'], 'invalid ids are ignored');
    assert.equal(listed[1]!.title, 'Acme 影视');

    const catalog = (await app.inject('/api/admin/sources')).json().sources as { id: string; title: string }[];
    assert.deepEqual(catalog.find(source => source.id === 'hongguo'), { id: 'hongguo', title: '红果短剧' }, 'built-in titles stay curated');
    assert.deepEqual(catalog.at(-1), { id: 'acme-tv', title: 'Acme' });
    assert.ok((await app.inject('/api/auth/me')).json().user.sourceIds.includes('acme-tv'), 'admin sees new sources');
    const created = await app.inject({ method: 'POST', url: '/api/admin/users', payload: { username: 'viewer', password: 'viewer-password', sourceIds: ['acme-tv'] } });
    assert.deepEqual(created.json().user.sourceIds, ['acme-tv']);

    const browse = await app.inject('/api/sources/acme-tv/browse?module=latest&page=1');
    assert.equal(browse.statusCode, 200, browse.body);
    assert.deepEqual(browse.json().items.map((item: { title: string; link: string }) => [item.title, item.link]), [['第七号', 'https://acme.example/v/7']]);
    const detail = await app.inject('/api/sources/acme-tv/detail?' + new URLSearchParams({ link: 'https://acme.example/v/7' }));
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().episodeItems.length, 1, 'a refused Backend helper fails only that request');
    const foreign = await app.inject('/api/sources/acme-tv/detail?' + new URLSearchParams({ link: `${process.env.CAPY_BACKEND_URL}/api/v1/providers/hongguo/items/1` }));
    assert.equal(foreign.statusCode, 502, 'widget links cannot point into another source on the Backend');

    const saved = JSON.parse(await readFile(join(dir, 'sources.json'), 'utf8')) as { sources: { id: string }[] };
    assert.ok(saved.sources.some(source => source.id === 'acme-tv'), 'registry persists across restarts');
    components = [{ id: 'hongguo', enabled: true }];
    assert.deepEqual(((await app.inject('/api/sources')).json() as { id: string }[]).map(source => source.id), ['hongguo'], 'uninstalled sources are hidden');
    assert.ok((await app.inject('/api/admin/sources')).json().sources.some((source: { id: string }) => source.id === 'acme-tv'), 'but their grants are kept');
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
