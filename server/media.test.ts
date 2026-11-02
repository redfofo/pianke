import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'short-media-test-'));
const originalDataDir = process.env.DATA_DIR;
const originalBackend = process.env.CAPY_BACKEND_URL;
process.env.DATA_DIR = dataDir;
process.env.CAPY_BACKEND_URL = '';
after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  if (originalBackend === undefined) delete process.env.CAPY_BACKEND_URL; else process.env.CAPY_BACKEND_URL = originalBackend;
});
// Module loading is under test: set isolated startup configuration before importing its consumers.
const { clearMediaGrants, grantPlayback, openMedia, registerMediaRoutes, rememberSourceType, rewritePlaylist } = await import('./media.js');
const { isAllowedUpstreamAddress, isPublicAddress } = await import('./provider-network.js');
const scope = { userId: 'media-test-user', sourceId: 'hongguo' };

test('media transport rejects private, mapped and encoded network destinations', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const url of ['http://2130706433/video.mp4', 'http://[::ffff:127.0.0.1]/video.mp4', 'file:///etc/passwd', 'http://user:password@8.8.8.8/video']) await assert.rejects(openMedia(url));
});

test('trusted fake-IP ranges allow only their own addresses and never private space', () => {
  const original = process.env.TRUSTED_FAKE_IP_CIDRS;
  try {
    delete process.env.TRUSTED_FAKE_IP_CIDRS;
    assert.equal(isAllowedUpstreamAddress('198.18.241.160'), false);
    process.env.TRUSTED_FAKE_IP_CIDRS = '198.18.0.0/15';
    assert.equal(isAllowedUpstreamAddress('198.18.241.160'), true);
    assert.equal(isAllowedUpstreamAddress('198.19.255.1'), true);
    for (const address of ['198.51.100.1', '127.0.0.1', '10.0.0.6', '192.168.1.1', '::1']) assert.equal(isAllowedUpstreamAddress(address), false, address);
    assert.equal(isAllowedUpstreamAddress('8.8.8.8'), true);
    for (const spec of ['10.0.0.0/8', '198.18.0.0/15,192.168.0.0/24', '0.0.0.0/1', '127.0.0.1/32', 'fdfe::/64', '198.18.0.0']) {
      process.env.TRUSTED_FAKE_IP_CIDRS = spec;
      assert.throws(() => isAllowedUpstreamAddress('198.18.0.1'), /TRUSTED_FAKE_IP_CIDRS/, spec);
    }
  } finally {
    if (original === undefined) delete process.env.TRUSTED_FAKE_IP_CIDRS; else process.env.TRUSTED_FAKE_IP_CIDRS = original;
  }
});

test('HLS media, variants, initialization fragments and encryption keys stay on the authenticated proxy', async () => {
  const playlist = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nvariant/list.m3u8\n#EXTINF:6,\nhttps://cdn.example.org/chunk.ts?token=abc\n';
  const rewritten = rewritePlaylist(playlist, 'https://video.example.org/show/master.m3u8', { Referer: 'https://source.example.org/' }, scope);
  const uris = [...rewritten.matchAll(/URI="([^"]+)"/g)].map(match => match[1]!);
  uris.push(...rewritten.split('\n').filter(line => line && !line.startsWith('#')));
  assert.equal(uris.length, 5);
  for (const uri of uris) {
    assert.equal(new URL(uri, 'https://player.example.org').origin, 'https://player.example.org');
    assert.match(uri, /^\/api\/media\/[\w-]+$/);
  }
  assert.match(rewritten, /METHOD=AES-128/);
  assert.match(rewritten, /BANDWIDTH=900000/);
  assert.match(rewritten, /#EXTINF:6,/);
});

test('HLS rejects unresolved variables and unsafe nested protocols', () => {
  assert.throws(() => rewritePlaylist('#EXTM3U\n{$missing}/seg.ts', 'https://example.org/a.m3u8', {}, scope), /变量/);
  assert.throws(() => rewritePlaylist('#EXTM3U\nfile:///etc/passwd', 'https://example.org/a.m3u8', {}, scope), /协议/);
});

test('unknown, modified and expired media grants cannot fetch an upstream resource', async () => {
  const app = Fastify();
  registerMediaRoutes(app);
  try {
    const expired = rewritePlaylist('#EXTM3U\nhttps://example.org/segment.ts', 'https://example.org/a.m3u8', {}, scope, Date.now() - 1).split('\n')[1]!;
    for (const url of ['/api/media/unknown', expired, `${expired}tampered`]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 410);
    }
  } finally { await app.close(); }
});

test('preflight-free grants need a known media type and forget learned types on backend change', () => {
  const scope = { userId: 'user', sourceId: 'dsd' };
  const candidate = { url: 'https://media.example/api/v1/stream/abc/media', headers: {}, title: '线路' };
  assert.equal(grantPlayback(candidate, scope), undefined);
  assert.equal(grantPlayback({ ...candidate, url: 'https://media.example/v/index.m3u8?sign=1' }, scope)?.type, 'application/x-mpegURL');
  assert.equal(grantPlayback({ ...candidate, url: 'https://media.example/v/clip.MP4' }, scope)?.type, 'video/mp4');
  assert.equal(grantPlayback({ ...candidate, type: 'video/webm' }, scope)?.type, 'video/webm');
  rememberSourceType('dsd', 'application/x-mpegURL');
  const granted = grantPlayback(candidate, scope);
  assert.equal(granted?.type, 'application/x-mpegURL');
  assert.match(granted!.src, /^\/api\/media\/[A-Za-z0-9_-]+$/);
  assert.equal(grantPlayback(candidate, { ...scope, sourceId: 'hongguo' }), undefined);
  clearMediaGrants();
  assert.equal(grantPlayback(candidate, scope), undefined);
});
