import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('catalog follows enabled upstream components without restarting or retaining removed widgets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'short-sources-'));
  const oldDir = process.env.DATA_DIR;
  const oldBackend = process.env.CAPY_BACKEND_URL;
  let components = [{ id: 'hongguo', enabled: true }, { id: 'huangdou', enabled: false }];
  let fail = false;
  let brokenWidget = false;
  let title = '原组件';
  const upstream = http.createServer((request, response) => {
    if (request.url === '/api/v1/components') {
      response.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ components }));
    }
    if (brokenWidget) {
      response.writeHead(503);
      return response.end('unavailable');
    }
    response.end(`var WidgetMetadata = { title: '${title}', modules: [{ id: 'hot', title: '热门', functionName: 'getList', params: [] }] };`);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  process.env.DATA_DIR = dir;
  process.env.CAPY_BACKEND_URL = `http://127.0.0.1:${address.port}`;
  // Configuration is read at module initialization, after the isolated upstream address is known.
  const { createAuthenticatedApp: createApp } = await import('./test-auth.js');
  const app = await createApp();
  try {
    const first = await app.inject('/api/sources');
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().map((row: { id: string }) => row.id), ['hongguo']);
    components = [{ id: 'hongguo', enabled: false }, { id: 'huangdou', enabled: true }];
    const changed = await app.inject('/api/sources');
    assert.deepEqual(changed.json().map((row: { id: string }) => row.id), ['huangdou']);
    components = [];
    assert.deepEqual((await app.inject('/api/sources')).json(), []);
    title = '重新安装的组件';
    components = [{ id: 'hongguo', enabled: true }];
    assert.equal((await app.inject('/api/sources')).json()[0].title, title);
    fail = true;
    assert.equal((await app.inject('/api/sources')).statusCode, 502, 'network failure is not an empty successful catalog');
    fail = false;
    components = [{ id: 'huangdou', enabled: true }];
    brokenWidget = true;
    const broken = (await app.inject('/api/sources')).json();
    assert.equal(broken[0].id, 'huangdou');
    assert.match(broken[0].error, /HTTP 503/, 'enabled but broken source remains visible for diagnosis');
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
    if (oldDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDir;
    if (oldBackend === undefined) delete process.env.CAPY_BACKEND_URL; else process.env.CAPY_BACKEND_URL = oldBackend;
  }
});
