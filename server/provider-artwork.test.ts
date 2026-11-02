import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Matches MissAV 5.9.9's throwing imageUrlExists and object-only detail artwork contracts.
const widget = `var WidgetMetadata = { title: 'MissAV', modules: [
  { id: 'list', title: 'List', functionName: 'getList', params: [{ name: 'page', type: 'page', value: '1' }] }
], search: { functionName: 'searchVideos', params: [{ name: 'keyword', type: 'input' }, { name: 'page', type: 'page' }] } };
async function imageUrlExists(url) {
  try { await Widget.http.get(url); return true; } catch { return false; }
}
async function getList() {
  const base = CAPY_BACKEND_URL + '/api/v1/missav/';
  const candidates = ['ai.jpg', 'regular.jpg'];
  const exists = await Promise.all(candidates.map(name => imageUrlExists(base + name)));
  const selected = candidates[exists.findIndex(Boolean)];
  const response = await Widget.http.get(base + 'list');
  const rows = JSON.parse(response.data);
  rows[0].posterPath = 'https://images.example/' + selected;
  return rows;
}
async function searchVideos(params) {
  const response = await Widget.http.get(CAPY_BACKEND_URL + '/api/v1/missav/search?q=' + encodeURIComponent(params.keyword));
  return JSON.parse(response.data);
}
async function loadDetail(item) {
  await Widget.http.post(CAPY_BACKEND_URL + '/api/v1/missav/detail', JSON.stringify(item));
  return { title: 'Target', posterPath: typeof item === 'object' ? item.posterPath : '',
    backdropPath: typeof item === 'object' ? item.backdropPath : '', videoUrl: 'https://video.example/movie.m3u8' };
}`;

test('MissAV rejects missing cover candidates, retains list artwork and recovers only canonical matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'short-provider-artwork-'));
  const oldDir = process.env.DATA_DIR;
  const oldBackend = process.env.CAPY_BACKEND_URL;
  const requests: string[] = [];
  let detailArgument: unknown;
  let version = 1;
  const row = () => ({ title: 'Target', detailUrl: '/cn/abc-123', posterPath: `https://images.example/regular.jpg?v=${version}`,
    fallbackCoverPath: `https://images.example/fallback.jpg?signature=${version}`, backdropPath: 'https://images.example/backdrop.jpg',
    posterHeaders: { Referer: 'https://images.example/' }, customHeaders: { Cookie: 'video-secret' } });
  const upstream = http.createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    requests.push(url.pathname);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v1/components') return response.end(JSON.stringify({ components: [{ id: 'missav', enabled: true }] }));
    if (url.pathname === '/widgets/missav.js') return response.end(widget);
    if (url.pathname === '/api/v1/providers/hongguo/items/legacy') return response.end(JSON.stringify({ title: 'Legacy',
      posterUrl: `/api/v1/providers/hongguo/cover?url=${encodeURIComponent(`https://images.example/legacy.jpg?signature=${version}`)}` }));
    if (url.pathname === '/api/v1/missav/ai.jpg') { response.statusCode = 404; return response.end('missing image'); }
    if (url.pathname === '/api/v1/missav/regular.jpg') return response.end('image');
    if (url.pathname === '/api/v1/missav/list') return response.end(JSON.stringify([row()]));
    if (url.pathname === '/api/v1/missav/search') return response.end(JSON.stringify([
      { ...row(), detailUrl: '/cn/wrong-999', posterPath: 'https://images.example/wrong.jpg' },
      { ...row(), detailUrl: 'https://mirror.example/dm18/ABC-123/' },
    ]));
    if (url.pathname === '/api/v1/missav/detail') {
      let body = '';
      request.on('data', data => { body += data; });
      request.on('end', () => { detailArgument = JSON.parse(body); response.end('{}'); });
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  process.env.DATA_DIR = dir;
  process.env.CAPY_BACKEND_URL = `http://127.0.0.1:${address.port}`;
  // Exercise startup configuration loading only after the isolated upstream address is known.
  const providers = await import('./providers.js');
  try {
    const result = await providers.browseSource('missav', 'list', {});
    assert.equal(result.items[0]!.posterUrl, 'https://images.example/regular.jpg', '404 ai candidate must not win');
    const artwork = providers.peekPosterArtwork('missav', '/cn/abc-123')!;
    assert.deepEqual(artwork.fallbackUrls, ['https://images.example/fallback.jpg?signature=1', 'https://images.example/backdrop.jpg']);
    assert.deepEqual(artwork.headers, { Referer: 'https://images.example/' }, 'video cookies are not image credentials');
    requests.length = 0;
    assert.equal((await providers.getDetail('missav', '/cn/abc-123')).posterUrl, artwork.url);
    assert.deepEqual(detailArgument, { link: '/cn/abc-123', detailUrl: '/cn/abc-123', posterPath: artwork.url, backdropPath: 'https://images.example/backdrop.jpg' });
    assert.deepEqual(requests, ['/api/v1/missav/detail'], 'browsed detail does not search again');
    assert.deepEqual(providers.peekPosterArtwork('missav', '/cn/abc-123')!.fallbackUrls?.toSorted(), artwork.fallbackUrls?.toSorted());
    requests.length = 0;
    assert.equal((await providers.resolvePosterArtwork('missav', '/cn/abc-123', 'Target')).url, artwork.url);
    assert.deepEqual(requests, [], 'poster resolution reuses trusted list artwork');

    providers.clearProviderCaches();
    assert.equal(providers.peekPosterArtwork('missav', '/cn/abc-123'), undefined);
    const recovered = await providers.resolvePosterArtwork('missav', '/cn/abc-123', 'Old empty history');
    assert.equal(recovered.url, 'https://images.example/regular.jpg?v=1', 'mirror path/case matches by canonical video ID, not the first title hit');
    assert.ok(recovered.fallbackUrls?.includes('https://images.example/fallback.jpg?signature=1'));
    providers.clearProviderCaches();
    requests.length = 0;
    const coldDetail = await providers.getDetail('missav', '/cn/abc-123');
    assert.equal(coldDetail.episodeItems.length, 1);
    assert.equal(requests.some(path => path === '/api/v1/missav/search'), false, 'cold artwork recovery must not block video detail');
    assert.equal((await providers.resolvePosterArtwork('missav', coldDetail.link, coldDetail.title)).url, recovered.url, 'the image endpoint can recover artwork independently');
    assert.equal((await providers.resolvePosterArtwork('missav', '/cn/missing-456', 'Target')).url, '', 'matching title cannot authorize a different video cover');

    version = 2;
    const refreshed = await providers.resolvePosterArtwork('missav', '/cn/abc-123', 'Target', true);
    assert.equal(refreshed.url, 'https://images.example/regular.jpg?v=2');
    assert.ok(refreshed.fallbackUrls?.includes('https://images.example/fallback.jpg?signature=2'));
    assert.equal(refreshed.fallbackUrls?.some(url => url.includes('signature=1')), false, 'stale signed fallback is replaced');
    await assert.rejects(providers.resolvePosterArtwork('missav', 'https://evil.example/admin', 'Target'), /MissAV/);
    await assert.rejects(providers.resolvePosterArtwork('unknown', '/cn/abc-123', 'Target'), /未知/);
    const legacyLink = process.env.CAPY_BACKEND_URL + '/api/v1/providers/hongguo/items/legacy';
    const legacy = await providers.resolvePosterArtwork('hongguo', legacyLink, 'Old empty history');
    assert.equal(new URL(legacy.url).searchParams.get('url'), 'https://images.example/legacy.jpg?signature=2', 'backend artwork resolution does not require playable episodes');
    await assert.rejects(providers.resolvePosterArtwork('hongguo', 'https://evil.example/api/v1/providers/hongguo/items/legacy', 'Legacy'), /Backend/);
  } finally {
    providers.closeProviders();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
    if (oldDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDir;
    if (oldBackend === undefined) delete process.env.CAPY_BACKEND_URL; else process.env.CAPY_BACKEND_URL = oldBackend;
  }
});
