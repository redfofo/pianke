import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountDatabase, type User } from './accounts.js';
import { Catalog, type CatalogItem } from './catalog.js';

const admin: User = { id: 'admin', username: 'admin', role: 'admin', createdAt: 0, sourceIds: [] };
const item = (n: number, name: string, overview = ''): CatalogItem => ({
  id: `item-${n}`, sourceId: 'hongguo', type: 'Series', parentId: Catalog.libraryId('hongguo'), link: `/item/${n}`, upstreamId: String(n),
  name, overview, posterUrl: '', indexNumber: null, parentIndexNumber: null, mediaType: 'tv', createdAt: n, updatedAt: n, detailAt: 0, available: 1,
});
const search = (catalog: Catalog, needle: string) =>
  catalog.query(admin, { recursive: true, search: needle, includeTypes: ['Series'], sortBy: 'DateCreated', limit: 1000 }).items.map(row => row.id).sort();
/** The pre-index matching rule, evaluated by scanning every row. */
const scan = (catalog: Catalog, needle: string) =>
  (catalog.accounts.db.prepare("SELECT id FROM media_items WHERE type = 'Series' AND (instr(lower(name), ?1) > 0 OR instr(lower(overview), ?1) > 0) ORDER BY id")
    .all(needle.toLocaleLowerCase()) as { id: string }[]).map(row => row.id).sort();
const checkIndex = (catalog: Catalog) => catalog.accounts.db.exec("INSERT INTO media_search(media_search, rank) VALUES ('integrity-check', 1)");

test('trigram search matches the substring rules and stays consistent while built in the background', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'short-catalog-search-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let accounts = new AccountDatabase(directory);
  let catalog = new Catalog(accounts);
  const names = ['同学的妈妈', '妈妈的朋友', 'ABC Story', '无码中出 合集', '"引号"剧场', '第 1 集'];
  names.forEach((name, n) => catalog.upsert(item(n, name, n === 2 ? '简介含 同学的 字样' : '')));
  for (const needle of ['同学的', '妈妈的', 'abc', 'abc story', '"引号"', '妈妈', '第 1 集', '不存在的词']) {
    assert.deepEqual(search(catalog, needle), scan(catalog, needle), needle);
  }
  assert.deepEqual(search(catalog, '同学的'), ['item-0', 'item-2'], 'overview text is searchable');
  catalog.upsert(item(0, '同学的妈妈'));
  catalog.upsert(item(1, '改名后的标题'));
  assert.deepEqual(search(catalog, '妈妈的'), [], 'renamed rows leave the index');
  checkIndex(catalog);

  // A catalog from before the index: its rows are indexed in batches while the catalog keeps changing.
  accounts.db.exec('DROP TRIGGER media_search_insert; DROP TRIGGER media_search_delete; DROP TRIGGER media_search_update; DROP TABLE media_search; DROP TABLE media_search_state');
  for (let n = 10; n < 30; n++) catalog.upsert(item(n, `旧剧集 ${n} 号`));
  accounts.close();
  accounts = new AccountDatabase(directory);
  catalog = new Catalog(accounts);
  assert.deepEqual(search(catalog, '旧剧集'), scan(catalog, '旧剧集'), 'searches scan until the index is complete');
  const db = accounts.db;
  const rowid = (id: string) => (db.prepare('SELECT rowid FROM media_items WHERE id = ?').get(id) as { rowid: number }).rowid;
  const watermark = () => (db.prepare('SELECT indexed FROM media_search_state').get() as { indexed: number }).indexed;
  await catalog.buildSearchIndex(() => watermark() >= rowid('item-11'), 2);
  assert.ok(watermark() >= rowid('item-11') && watermark() < rowid('item-25'), 'stopped part-way');
  catalog.upsert(item(10, '已索引后改名'));
  catalog.upsert(item(25, '未索引时改名'));
  db.prepare('DELETE FROM media_items WHERE id IN (?, ?)').run('item-11', 'item-27');
  catalog.upsert(item(40, '构建期间新增 旧剧集'));
  await catalog.buildSearchIndex();
  checkIndex(catalog);
  for (const needle of ['旧剧集', '改名', '同学的', '构建期间']) assert.deepEqual(search(catalog, needle), scan(catalog, needle), needle);
  assert.equal(search(catalog, '旧剧集').length, 20 - 2 - 2 + 1, 'renames, deletions and additions are all reflected');
  accounts.close();
});
