import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('playback modes keep direct media off both relays and reject upstream-only playback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'short-playback-'));
  const oldDir = process.env.DATA_DIR;
  const oldBackend = process.env.CAPY_BACKEND_URL;
  const requests: string[] = [];
  let origin = '';
  let mode = 'direct';
  const upstream = http.createServer((request, response) => {
    const path = request.url!;
    requests.push(path);
    response.setHeader('Content-Type', 'application/json');
    if (path === '/api/v1/providers/hongguo/items/test') {
      const sources = mode === 'direct' ? [
        { url: 'https://cdn.example.invalid/movie.mp4?token=a%2Fb', headers: { Referer: 'https://source.example/', Cookie: 'secret=1' } },
        { url: 'https://cdn.example.invalid/master.m3u8?token=hls' },
      ] : mode === 'mixed' ? [{ url: origin + '/api/v1/stream/unsupported' }, { url: 'https://cdn.example.invalid/good.mp4' }] : [{ url: origin + '/api/v1/playback/token/media' }];
      response.end(JSON.stringify({ title: '测试影片', seasons: [{ seasonNumber: 1, episodes: [{ id: 'one', sources }] }] }));
    } else if (path === '/api/v1/providers/hongguo/items/dup-same' || path === '/api/v1/providers/hongguo/items/dup-diff') {
      const episode = (page: string, media: string) => ({ id: 's1e1', episodeNumber: 1, videoUrl: `https://cdn.example.invalid/${media}.m3u8`, customHeaders: { Referer: `https://source.example/video/${page}/` } });
      const second = path.endsWith('dup-same') ? episode('2', 'one') : episode('2', 'other');
      response.end(JSON.stringify({ title: '单集影片', seasons: [{ seasonNumber: 1, episodes: [episode('1', 'one'), second, { ...episode('3', 'one'), id: 's1e2', episodeNumber: 2 }] }] }));
    } else if (path === '/api/v1/playback/token') {
      response.end(JSON.stringify({ videoUrl: mode === 'resolved' ? 'https://cdn.example.invalid/signed?id=123' : mode === 'unsafe' ? 'javascript:alert(1)' : origin + '/api/v1/playback/token/playlist.m3u8', contentType: 'application/vnd.apple.mpegurl', headers: { Cookie: 'secret=1' } }));
    } else if (path === '/api/v1/playback/unsupported') {
      response.statusCode = 400;
      response.end(JSON.stringify({ detail: '该播放项不支持客户端直连解析' }));
    } else if (path === '/api/v1/playback/token/media') {
      response.setHeader('Content-Type', 'video/mp4');
      response.end('fixture-video');
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  process.env.DATA_DIR = dir;
  process.env.CAPY_BACKEND_URL = origin;
  // Config is initialized at module load; import only after setting the isolated startup environment.
  const { createAuthenticatedApp: createApp } = await import('./test-auth.js');
  const app = await createApp();
  const play = (serverProxy?: boolean, refresh = true) => app.inject({ method: 'POST', url: '/api/sources/hongguo/playback', payload: { link: origin + '/api/v1/providers/hongguo/items/test', episodeId: 's1:one', refresh, ...(serverProxy === undefined ? {} : { serverProxy }) } });
  try {
    const direct = await play(false);
    assert.equal(direct.statusCode, 200);
    assert.deepEqual(direct.json().sources, [
      { src: 'https://cdn.example.invalid/movie.mp4?token=a%2Fb', type: 'video/mp4', title: '线路 1' },
      { src: 'https://cdn.example.invalid/master.m3u8?token=hls', type: 'application/x-mpegURL', title: '线路 2' },
    ]);
    assert.deepEqual(requests, ['/api/v1/providers/hongguo/items/test']);
    requests.length = 0;
    mode = 'resolved';
    const cached = await play(false, false);
    assert.deepEqual(cached.json().sources, direct.json().sources);
    assert.deepEqual(requests, [], 'recent detail is reused without re-resolving upstream');
    requests.length = 0;
    const resolved = await play(false);
    assert.equal(resolved.statusCode, 200);
    assert.deepEqual(resolved.json().sources, [{ src: 'https://cdn.example.invalid/signed?id=123', type: 'application/vnd.apple.mpegurl', title: '默认线路' }]);
    assert.deepEqual(requests, ['/api/v1/providers/hongguo/items/test', '/api/v1/playback/token']);
    mode = 'relay';
    requests.length = 0;
    const unsupported = await play(false);
    assert.equal(unsupported.statusCode, 502);
    assert.match(unsupported.json().error, /直链/);
    assert.deepEqual(requests, ['/api/v1/providers/hongguo/items/test', '/api/v1/playback/token']);
    mode = 'unsafe';
    assert.equal((await play(false)).statusCode, 502);
    mode = 'mixed';
    const mixed = await play(false);
    assert.equal(mixed.statusCode, 200);
    assert.deepEqual(mixed.json().sources, [{ src: 'https://cdn.example.invalid/good.mp4', type: 'video/mp4', title: '线路 2' }]);
    mode = 'relay';
    for (const setting of [true, undefined]) {
      const proxied = await play(setting);
      assert.equal(proxied.statusCode, 200);
      const src = proxied.json().sources[0].src;
      assert.match(src, /^\/api\/media\//);
      assert.equal((await app.inject(src)).body, 'fixture-video');
    }
    const detail = (item: string) => app.inject({ method: 'GET', url: '/api/sources/hongguo/detail?link=' + encodeURIComponent(origin + '/api/v1/providers/hongguo/items/' + item) });
    const merged = await detail('dup-same');
    assert.equal(merged.statusCode, 200);
    assert.deepEqual(merged.json().episodeItems.map((episode: { id: string; customHeaders: Record<string, string> }) => [episode.id, episode.customHeaders.Referer]), [['s1:s1e1', 'https://source.example/video/1/'], ['s1:s1e2', 'https://source.example/video/3/']]);
    const ambiguous = await detail('dup-diff');
    assert.equal(ambiguous.statusCode, 502);
    assert.match(ambiguous.json().error, /重复集数标识/);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
    if (oldDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDir;
    if (oldBackend === undefined) delete process.env.CAPY_BACKEND_URL; else process.env.CAPY_BACKEND_URL = oldBackend;
  }
});
