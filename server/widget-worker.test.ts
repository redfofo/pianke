import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';

test('Widget.http rejects HTTP failures with response metadata while fetch preserves non-2xx responses', { timeout: 10000 }, async (context) => {
  const workerPath = resolve('dist/server/widget-worker.js');
  const child = fork(workerPath, [], { execArgv: ['--permission', `--allow-fs-read=${workerPath}`, '--no-addons', '--disable-proto=throw'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  context.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr?.on('data', data => { stderr += data; });
  const requests: { method: string; url: string; body?: string }[] = [];
  try {
    const result = await new Promise<unknown>((resolveResult, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Worker exited ${code}: ${stderr}`)));
      child.on('message', (message: { kind: string; id: number; url: string; options: { method: string; body?: string }; error?: string; result?: unknown }) => {
        if (message.kind === 'result') {
          if (message.error) reject(new Error(message.error)); else resolveResult(message.result);
          return;
        }
        if (message.kind !== 'http') return;
        requests.push({ method: message.options.method, url: message.url, ...(message.options.body ? { body: message.options.body } : {}) });
        const status = Number(new URL(message.url).pathname.slice(1));
        child.send({ kind: 'http-result', id: message.id, response: { status, headers: { 'content-type': 'text/plain' }, data: `body-${status}`, url: message.url } });
      });
      child.send({ kind: 'start', backendUrl: 'https://fixture.example', functionName: 'run', argument: null, code: `
        async function run() {
          const errors = [];
          for (const [method, status] of [['get', 404], ['post', 503], ['get', 302]]) {
            try {
              if (method === 'post') await Widget.http.post('https://fixture.example/' + status, { test: true });
              else await Widget.http.get('https://fixture.example/' + status, { allow_redirects: false });
              errors.push({ resolved: true });
            } catch (error) {
              errors.push({ message: error.message, status: error.status, statusCode: error.statusCode, response: error.response });
            }
          }
          const native = await fetch('https://fixture.example/404');
          const success = await Widget.http.get('https://fixture.example/204');
          return { errors, native: { status: native.status, ok: native.ok, body: await native.text() }, success };
        }
      ` });
    });
    assert.deepEqual(result, {
      errors: [404, 503, 302].map(status => ({ message: `HTTP ${status}: https://fixture.example/${status}`, status, statusCode: status,
        response: { data: `body-${status}`, status, ok: false, headers: { 'content-type': 'text/plain' }, url: `https://fixture.example/${status}` } })),
      native: { status: 404, ok: false, body: 'body-404' },
      success: { status: 204, ok: true, data: '', headers: { 'content-type': 'text/plain' }, url: 'https://fixture.example/204' },
    });
    assert.deepEqual(requests[1], { method: 'POST', url: 'https://fixture.example/503', body: '{"test":true}' });
  } finally {
    child.kill('SIGKILL');
  }
});
