import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const widget = `var WidgetMetadata = { title: '红果短剧', search: { functionName: 'search', params: [] }, modules: [
  { id: 'hongguo-short', title: '短剧', functionName: 'getHongguoShort', params: [{ name: 'page', type: 'page', value: '1' }] },
] };`;

test('a failing upstream search answers from the catalog when it holds matching titles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'short-search-fallback-'));
  const oldDir = process.env.DATA_DIR;
  const oldBackend = process.env.CAPY_BACKEND_URL;
  let failing = false;
  const upstream = http.createServer((request, response) => {
    const path = request.url!;
    if (path === '/api/v1/components') return response.end(JSON.stringify({ components: [{ id: 'hongguo', enabled: true }] }));
    if (path === '/widgets/hongguo.js') return response.end(widget);
    response.setHeader('Content-Type', 'application/json');
    if (failing) { response.statusCode = 504; return response.end(JSON.stringify({ detail: 'Worker 搜索超时' })); }
    response.end(JSON.stringify({ items: [{ id: 'b1', title: '霸道总裁爱上我', mediaType: 'tv' }], page: 1, pageCount: 1, total: 1 }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  process.env.DATA_DIR = dir;
  process.env.CAPY_BACKEND_URL = `http://127.0.0.1:${address.port}`;
  const { createAuthenticatedApp: createApp } = await import('./test-auth.js');
  const app = await createApp();
  const search = (q: string) => app.inject(`/api/sources/hongguo/search?q=${encodeURIComponent(q)}&page=1`);
  try {
    const live = await search('霸道');
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(live.json().local, undefined);
    failing = true;
    const local = await search('总裁');
    assert.equal(local.statusCode, 200, local.body);
    assert.equal(local.json().local, true);
    assert.deepEqual(local.json().items.map((item: { title: string }) => item.title), ['霸道总裁爱上我']);
    assert.equal(local.json().items[0].link, live.json().items[0].link, 'local results open the same detail page');
    assert.equal((await search('无此剧')).statusCode, 502, 'without catalog matches the upstream failure is reported');
    assert.match((await app.inject('/api/status')).json().sources.hongguo.search.message, /Worker 搜索超时/);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
    if (oldDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDir;
    if (oldBackend === undefined) delete process.env.CAPY_BACKEND_URL; else process.env.CAPY_BACKEND_URL = oldBackend;
  }
});
