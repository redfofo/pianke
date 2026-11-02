import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const widget = `var WidgetMetadata = { title: '红果短剧', modules: [
  { id: 'hongguo-short', title: '短剧', functionName: 'getHongguoShort', params: [{ name: 'page', type: 'page', value: '1' }] },
  { id: 'hongguo-history', title: '历史', functionName: 'getHongguoHistory', params: [] },
] };`;

test('list results are deduplicated and cached, health checks bypass cache, shared upstream history is inaccessible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'short-list-cache-'));
  const oldDir = process.env.DATA_DIR;
  const oldBackend = process.env.CAPY_BACKEND_URL;
  const requests: string[] = [];
  let served = 0;
  const upstream = http.createServer((request, response) => {
    const path = request.url!;
    if (path === '/api/v1/components') return response.end(JSON.stringify({ components: [{ id: 'hongguo', enabled: true }] }));
    if (path === '/widgets/hongguo.js') return response.end(widget);
    requests.push(path.split('?')[0] + '?' + new URLSearchParams(path.split('?')[1]).get('page'));
    response.setHeader('Content-Type', 'application/json');
    // Delay lets concurrent identical requests overlap.
    const n = ++served;
    setTimeout(() => response.end(JSON.stringify({ items: [{ id: String(n), title: '剧 ' + n }], page: 1, pageCount: 3, total: 3 })), 50);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  process.env.DATA_DIR = dir;
  process.env.CAPY_BACKEND_URL = `http://127.0.0.1:${address.port}`;
  const { createAuthenticatedApp: createApp } = await import('./test-auth.js');
  const app = await createApp();
  const get = async (url: string) => { const response = await app.inject(url); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  try {
    const [first, concurrent] = await Promise.all([get('/api/sources/hongguo/browse?module=hongguo-short&page=1'), get('/api/sources/hongguo/browse?module=hongguo-short&page=1')]);
    assert.deepEqual(concurrent, first);
    assert.deepEqual(await get('/api/sources/hongguo/browse?module=hongguo-short&page=1'), first);
    assert.deepEqual(requests, ['/api/v1/providers/hongguo/browse?1'], 'one upstream call serves concurrent and repeated pages');
    await get('/api/sources/hongguo/browse?module=hongguo-short&page=2');
    await get('/api/sources/hongguo/search?q=test');
    await get('/api/sources/hongguo/search?q=test');
    assert.deepEqual(requests.slice(1), ['/api/v1/providers/hongguo/browse?2', '/api/v1/providers/hongguo/search?1']);
    requests.length = 0;
    const catalog = await get('/api/sources');
    assert.equal(catalog[0].modules.some((module: { id: string }) => module.id === 'hongguo-history'), false);
    const history = await app.inject('/api/sources/hongguo/browse?module=hongguo-history');
    assert.equal(history.statusCode, 403);
    assert.deepEqual(requests, [], 'shared upstream history is never requested');
    requests.length = 0;
    const check = await app.inject({ method: 'POST', url: '/api/sources/hongguo/check' });
    assert.equal(check.json().browse.ok, true);
    assert.deepEqual(requests, ['/api/v1/providers/hongguo/browse?1'], 'health checks reach upstream');
    assert.notDeepEqual(await get('/api/sources/hongguo/browse?module=hongguo-short&page=1'), first, 'a fresh check refreshes the cached page');
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
    if (oldDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDir;
    if (oldBackend === undefined) delete process.env.CAPY_BACKEND_URL; else process.env.CAPY_BACKEND_URL = oldBackend;
  }
});
