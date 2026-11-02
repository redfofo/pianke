import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountDatabase } from './accounts.js';
import { Catalog, rebaseProviderLink } from './catalog.js';
import { episodeKey, recordKey } from '../src/storage.js';
import type { Detail } from '../src/types.js';

const detail = (episodeIds: string[]): Detail => ({
  id: 'upstream-series',
  sourceId: 'hongguo',
  title: '本地详情测试',
  posterUrl: `/api/posters/${'a'.repeat(64)}`,
  description: '已持久化简介',
  link: 'https://backend.example/detail/1',
  mediaType: 'tv',
  seasons: [{
    seasonNumber: 1,
    title: '第一季',
    episodes: episodeIds.map((id, index) => ({
      id,
      title: `第 ${index + 1} 集`,
      episodeNumber: index + 1,
      seasonNumber: 1,
      videoUrl: `https://media.example/${id}.m3u8`,
      link: 'https://backend.example/detail/1',
    })),
  }],
  episodeItems: [],
});

test('catalog detail metadata survives restart without persisting playable URLs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'short-catalog-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let accounts = new AccountDatabase(directory);
  let catalog = new Catalog(accounts);
  catalog.ingestDetail(detail(['episode-1', 'episode-2']));
  accounts.close();

  accounts = new AccountDatabase(directory);
  catalog = new Catalog(accounts);
  const cached = catalog.cachedDetail('hongguo', 'https://backend.example/detail/1');
  assert.ok(cached);
  assert.equal(cached.description, '已持久化简介');
  assert.deepEqual(cached.episodeItems.map(episode => episode.id), ['episode-1', 'episode-2']);
  assert.ok(cached.episodeItems.every(episode => episode.videoUrl === ''));

  catalog.ingestDetail(detail(['episode-2']));
  assert.deepEqual(catalog.cachedDetail('hongguo', cached.link)?.episodeItems.map(episode => episode.id), ['episode-2']);
  accounts.close();
});

test('catalog queries filter, count, sort and page in the database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'short-catalog-query-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accounts = new AccountDatabase(directory);
  t.after(() => accounts.close());
  const catalog = new Catalog(accounts);
  const user = await accounts.createUser('query_user', 'query-password-1', 'user', ['hongguo']);
  const series = catalog.ingestDetail(detail(['episode-1', 'episode-2', 'episode-3']));
  catalog.ingestBrowse({
    items: ['北京', '阿里', 'Zebra'].map((title, index) => ({
      id: `browse-${index}`, sourceId: 'hongguo', title, posterUrl: '', description: '', link: `https://backend.example/detail/b${index}`, mediaType: 'tv',
    })),
    page: 1,
    hasMore: false,
  });
  const library = Catalog.libraryId('hongguo');

  assert.deepEqual(catalog.query(user, { parentId: '' }).items.map(item => item.id), [library]);
  assert.equal(catalog.query(user, { parentId: '', recursive: true, includeTypes: ['Episode'], limit: 0 }).total, 3);
  assert.equal(catalog.query(user, { parentId: series.id, recursive: true, includeTypes: ['Episode'] }).total, 3);
  assert.equal(catalog.query(user, { parentId: library, recursive: true, excludeTypes: ['Season', 'Episode'] }).total, 4);
  assert.equal(catalog.query(user, { parentId: library, recursive: true, includeTypes: ['series'] }).total, 4, 'item types match case-insensitively');
  assert.equal(catalog.query(user, { parentId: library, recursive: true, excludeTypes: ['season', 'EPISODE'] }).total, 4);

  const names = catalog.query(user, { parentId: library, sortBy: 'SortName' });
  assert.deepEqual(names.items.map(item => item.name), ['阿里', '北京', '本地详情测试', 'Zebra']);
  const page = catalog.query(user, { parentId: library, sortBy: 'SortName', descending: true, start: 1, limit: 2 });
  assert.deepEqual([page.total, ...page.items.map(item => item.name)], [4, '本地详情测试', '北京']);
  const random = catalog.query(user, { parentId: library, sortBy: 'Random' });
  assert.deepEqual(random.items.map(item => item.name).sort(), [...names.items.map(item => item.name)].sort());
  catalog.ingestBrowse({
    items: [{ id: 'browse-new', sourceId: 'hongguo', title: '安静', posterUrl: '', description: '', link: 'https://backend.example/detail/new', mediaType: 'tv' }],
    page: 1,
    hasMore: false,
  });
  assert.deepEqual(catalog.query(user, { parentId: library, sortBy: 'SortName', limit: 2 }).items.map(item => item.name), ['阿里', '安静']);
  assert.deepEqual(catalog.query(user, { recursive: true, search: '详情' }).items.map(item => item.id), [series.id]);

  const episode = catalog.query(user, { parentId: series.id, recursive: true, includeTypes: ['Episode'], limit: 1 }).items[0]!;
  catalog.patchUserData(user.id, episode.id, { positionTicks: 50, runtimeTicks: 100, lastPlayedAt: 1 });
  catalog.patchUserData(user.id, series.id, { favorite: true });
  assert.deepEqual(catalog.query(user, { recursive: true, resumable: true }).items.map(item => item.id), [episode.id]);
  assert.deepEqual(catalog.query(user, { recursive: true, favorite: true }).items.map(item => item.id), [series.id]);
  assert.equal(catalog.query(user, { recursive: true, includeTypes: ['Episode'], favorite: false }).total, 3);
  assert.equal(catalog.query(user, { recursive: true, includeTypes: ['Episode'], sortBy: 'DatePlayed', descending: true }).items[0]!.id, episode.id);

  const outsider = await accounts.createUser('outsider_user', 'query-password-2', 'user', []);
  assert.equal(catalog.query(outsider, { recursive: true }).total, 0);
});

test('titles from an earlier backend move to the current one with their user data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'short-catalog-rebase-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accounts = new AccountDatabase(directory);
  t.after(() => accounts.close());
  const catalog = new Catalog(accounts);
  const user = await accounts.createUser('rebase_user', 'rebase-password-1', 'user', ['hongguo']);
  const oldRoot = 'http://10.0.0.6:8788';
  const newRoot = 'http://10.0.0.10:8789';
  const link = (root: string, id: string) => `${root}/api/v1/providers/hongguo/items/${id}`;
  const poster = (sourceId: string, value: string) => `/api/posters/${Buffer.from(value).toString('hex').slice(0, 8)}`;
  assert.equal(rebaseProviderLink('hongguo', link(oldRoot, '7'), newRoot), link(newRoot, '7'));
  assert.equal(rebaseProviderLink('dsd', link(oldRoot, '7'), newRoot), link(oldRoot, '7'));
  assert.equal(rebaseProviderLink('missav', '/cn/abc-123', newRoot), '/cn/abc-123');

  // "moved" exists only under the old backend; "merged" was also synced again from the new one.
  const moved = catalog.ingestDetail({ ...detail(['m1', 'm2']), link: link(oldRoot, 'moved'), title: '迁移剧' });
  const merged = catalog.ingestDetail({ ...detail(['d1']), link: link(oldRoot, 'merged'), title: '重复剧' });
  const current = catalog.ingestBrowse({ items: [{ id: 'merged', sourceId: 'hongguo', title: '重复剧', posterUrl: '', description: '', link: link(newRoot, 'merged'), mediaType: 'tv' }], page: 1, hasMore: false })[0]!;
  const movedEpisode = Catalog.episodeId(moved.id, 'm2');
  catalog.patchUserData(user.id, movedEpisode, { positionTicks: 40, runtimeTicks: 100, lastPlayedAt: 5 });
  catalog.patchUserData(user.id, merged.id, { favorite: true });
  const watch = { key: episodeKey('hongguo', moved.link, 'm2'), mediaKey: recordKey('hongguo', moved.link), sourceId: 'hongguo', mediaId: 'moved',
    link: moved.link, title: '迁移剧', posterUrl: '/api/posters/old', episodeId: 'm2', episodeTitle: '第 2 集', position: 4, duration: 10, updatedAt: 5 };
  accounts.db.prepare('INSERT INTO watches VALUES (?, ?, ?, ?, ?)').run(user.id, watch.key, watch.mediaKey, JSON.stringify(watch), 5);

  assert.equal(await catalog.rebaseBackend(newRoot, poster), 2);
  assert.equal(catalog.get(moved.id), undefined);
  assert.equal(catalog.get(merged.id), undefined);
  const movedNow = catalog.findMedia('hongguo', link(newRoot, 'moved'))!;
  assert.equal(movedNow.id, Catalog.mediaId('hongguo', link(newRoot, 'moved')));
  assert.equal(movedNow.posterUrl, poster('hongguo', link(newRoot, 'moved')));
  assert.deepEqual(catalog.cachedDetail('hongguo', movedNow.link)?.episodeItems.map(episode => episode.id), ['m1', 'm2']);
  assert.equal(catalog.userData(user.id, Catalog.episodeId(movedNow.id, 'm2'))?.positionTicks, 40);
  assert.deepEqual(catalog.query(user, { recursive: true, resumable: true }).items.map(item => item.id), [Catalog.episodeId(movedNow.id, 'm2')]);
  // The merge keeps one title and carries the old episodes over to the empty browse entry.
  assert.equal(catalog.query(user, { parentId: Catalog.libraryId('hongguo'), search: '重复剧' }).total, 1);
  assert.equal(catalog.userData(user.id, current.id)?.favorite, 1);
  assert.equal(catalog.query(user, { parentId: current.id, recursive: true, includeTypes: ['Episode'] }).total, 1);

  const rows = accounts.db.prepare('SELECT key, mediaKey, record FROM watches WHERE userId = ?').all(user.id) as { key: string; mediaKey: string; record: string }[];
  assert.deepEqual(rows.map(row => [row.key, row.mediaKey, JSON.parse(row.record).link]),
    [[episodeKey('hongguo', link(newRoot, 'moved'), 'm2'), recordKey('hongguo', link(newRoot, 'moved')), link(newRoot, 'moved')]]);
  assert.equal(await catalog.rebaseBackend(newRoot, poster), 0);
});

test('a backend move runs in batches that yield to other work and can stop part-way', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'short-catalog-rebase-batches-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accounts = new AccountDatabase(directory);
  t.after(() => accounts.close());
  const catalog = new Catalog(accounts);
  const link = (root: string, id: number) => `${root}/api/v1/providers/hongguo/items/${id}`;
  const oldRoot = 'http://10.0.0.6:8788';
  const newRoot = 'http://10.0.0.10:8789';
  catalog.ingestBrowse({
    items: Array.from({ length: 120 }, (_, index) => ({ id: String(index), sourceId: 'hongguo', title: `剧 ${index}`, posterUrl: '', description: '', link: link(oldRoot, index), mediaType: 'tv' })),
    page: 1,
    hasMore: false,
  });
  const poster = () => '';
  let checks = 0;
  const first = await catalog.rebaseBackend(newRoot, poster, () => ++checks > 1);
  assert.ok(first > 0 && first <= 50, 'stopping keeps the batch already committed');
  let interleaved = false;
  setImmediate(() => { interleaved = true; });
  assert.equal(await catalog.rebaseBackend(newRoot, poster), 120 - first);
  assert.ok(interleaved, 'other queued work runs between batches');
  assert.equal(catalog.findMedia('hongguo', link(oldRoot, 7)), undefined);
  assert.ok(catalog.findMedia('hongguo', link(newRoot, 119)));
});
