import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
async function child(dataDir: string, script: string, backendUrl = '') {
  return execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, CAPY_BACKEND_URL: backendUrl, UPSTREAM_DOH_URL: '' },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
}

const imports = `
  import assert from 'node:assert/strict';
  import { createAuthenticatedApp as createApp } from './server/test-auth.ts';
  import { getConfig, saveBackendUrl, withSourceOperation } from './server/config.ts';
`;

test('empty boot serves health/config and rejects unconfigured, invalid and cross-site operations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'short-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await child(dir, imports + `
    const app = await createApp();
    try {
      assert.equal((await app.inject('/api/health')).statusCode, 200);
      assert.deepEqual((await app.inject('/api/config')).json(), { backendUrl: '', persisted: false });
      const sources = await app.inject('/api/sources');
      assert.equal(sources.statusCode, 503);
      assert.match(sources.json().error, /设置/);
      for (const backendUrl of ['', 'ftp://example.org', 'http://user:pass@example.org', 'http://example.org/path', 'http://example.org/..', 'http://example.org/?', 'http://example.org/#', 'http://localhost:8789']) {
        const response = await app.inject({ method: 'POST', url: '/api/config', headers: { host: 'localhost:8789' }, payload: { backendUrl } });
        assert.equal(response.statusCode, 400, backendUrl);
      }
      for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
        assert.equal((await app.inject({ method: 'POST', url: '/api/config', headers, payload: { backendUrl: 'https://upstream.example' } })).statusCode, 403);
      }
      assert.deepEqual(getConfig(), { backendUrl: '', persisted: false });
    } finally { await app.close(); }
  `);
});

test('normalized saves survive process restart and override the bootstrap environment', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'short-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await child(dir, imports + `
    const app = await createApp();
    try {
      assert.deepEqual(getConfig(), { backendUrl: 'http://bootstrap.example', persisted: false });
      const response = await app.inject({ method: 'POST', url: '/api/config', payload: { backendUrl: '  HTTPS://Saved.Example:443/  ' } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { backendUrl: 'https://saved.example', persisted: true });
    } finally { await app.close(); }
  `, 'http://bootstrap.example/');
  await child(dir, imports + `assert.deepEqual(getConfig(), { backendUrl: 'https://saved.example', persisted: true });`, 'https://different.example');
  await child(dir, imports + `assert.deepEqual(getConfig(), { backendUrl: 'https://saved.example', persisted: true });`, 'invalid stale bootstrap');
});

test('invalid bootstrap and saved configuration fail startup clearly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'short-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(child(dir, imports, 'http://example.org/path'), /CAPY_BACKEND_URL/);
  await writeFile(join(dir, 'config.json'), '{broken json');
  await assert.rejects(child(dir, imports), /配置文件.*无效/);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ backendUrl: '' }));
  await assert.rejects(child(dir, imports), /配置文件.*无效/);
});

test('atomic write failure leaves the active address and persisted flag untouched', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'short-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await child(dir, imports + `
    import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
    import { join } from 'node:path';
    const app = await createApp();
    try {
      await saveBackendUrl('https://original.example', () => {});
      const file = join(process.env.DATA_DIR, 'config.json');
      await rename(file, file + '.backup');
      await mkdir(file);
      const response = await app.inject({ method: 'POST', url: '/api/config', payload: { backendUrl: 'https://replacement.example' } });
      assert.equal(response.statusCode, 500);
      assert.match(response.json().error, /当前配置未更改/);
      assert.deepEqual(getConfig(), { backendUrl: 'https://original.example', persisted: true });
      assert.deepEqual(JSON.parse(await readFile(file + '.backup', 'utf8')), { backendUrl: 'https://original.example' });
      assert.equal((await readdir(process.env.DATA_DIR)).some(name => name.endsWith('.tmp')), false);
    } finally { await app.close(); }
  `);
});

test('source handler lifetime excludes saves, and pending saves exclude all source operations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'short-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await child(dir, imports + `
    import http from 'node:http';
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    const upstream = http.createServer(async (_request, response) => {
      arrived.resolve();
      await release.promise;
      response.end(JSON.stringify({ components: [] }));
    });
    const listening = Promise.withResolvers();
    upstream.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const original = 'http://127.0.0.1:' + upstream.address().port;
    const app = await createApp();
    try {
      await saveBackendUrl(original, () => {});
      const running = app.inject('/api/sources').then(response => response);
      await arrived.promise;
      const blocked = await app.inject({ method: 'POST', url: '/api/config', payload: { backendUrl: 'https://replacement.example' } });
      assert.equal(blocked.statusCode, 409);
      assert.equal(getConfig().backendUrl, original);
      release.resolve();
      assert.equal((await running).statusCode, 200);
      const saving = saveBackendUrl('https://replacement.example', () => {});
      await assert.rejects(withSourceOperation(() => assert.fail('must not start')), error => error.statusCode === 409);
      await assert.rejects(saveBackendUrl('https://other.example', () => {}), error => error.statusCode === 409);
      await saving;
      assert.equal(getConfig().backendUrl, 'https://replacement.example');
      await assert.rejects(withSourceOperation(async () => { throw new Error('source failed'); }), /source failed/);
      await saveBackendUrl(original, () => {});
    } finally {
      release.resolve();
      await app.close();
      const closed = Promise.withResolvers();
      upstream.close(closed.resolve);
      await closed.promise;
    }
  `);
});

test('cutover clears source status and old media grants, including delayed HLS responses', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'short-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await child(dir, imports + `
    import http from 'node:http';
    import { rewritePlaylist } from './server/media.ts';
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    const upstream = http.createServer(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.write('#EXTM3U\\n');
      arrived.resolve();
      await release.promise;
      response.end('segment.ts\\n');
    });
    const listening = Promise.withResolvers();
    upstream.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const original = 'http://127.0.0.1:' + upstream.address().port;
    const app = await createApp();
    try {
      await saveBackendUrl(original, () => {});
      await app.inject({ method: 'POST', url: '/api/sources/hongguo/playback-report', payload: { ok: true, message: 'old status' } });
      const userId = (await app.inject('/api/auth/me')).json().user.id;
      const token = rewritePlaylist('#EXTM3U\\n' + original + '/api/v1/stream/master.m3u8', original + '/', {}, { userId, sourceId: 'hongguo' }).split('\\n')[1];
      const pending = app.inject(token).then(response => response);
      await arrived.promise;
      const saved = await app.inject({ method: 'POST', url: '/api/config', payload: { backendUrl: 'https://replacement.example' } });
      assert.equal(saved.statusCode, 200);
      assert.deepEqual((await app.inject('/api/status')).json().sources.hongguo, {});
      assert.equal((await app.inject(token)).statusCode, 410);
      release.resolve();
      assert.equal((await pending).statusCode, 410);
    } finally {
      release.resolve();
      await app.close();
      const closed = Promise.withResolvers();
      upstream.close(closed.resolve);
      await closed.promise;
    }
  `);
});
