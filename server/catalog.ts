import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { BrowseResult, Detail, MediaItem } from '../src/types.js';
import { episodeKey, recordKey, type FavoriteRecord, type RecentRecord, type WatchRecord } from '../src/storage.js';
import type { AccountDatabase, User } from './accounts.js';
import { knownSourceIds, sourceEntries } from './source-registry.js';

const catalogItemTypes = ['CollectionFolder', 'Series', 'Season', 'Episode', 'Movie'] as const;
export type CatalogItemType = typeof catalogItemTypes[number];

export interface CatalogItem {
  id: string;
  sourceId: string;
  type: CatalogItemType;
  parentId: string;
  link: string;
  upstreamId: string;
  name: string;
  overview: string;
  posterUrl: string;
  indexNumber: number | null;
  parentIndexNumber: number | null;
  mediaType: string;
  createdAt: number;
  updatedAt: number;
  detailAt: number;
  available: number;
}

export interface UserItemData {
  userId: string;
  itemId: string;
  favorite: number;
  played: number;
  playCount: number;
  positionTicks: number;
  runtimeTicks: number;
  lastPlayedAt: number | null;
  updatedAt: number;
}

export interface CatalogQuery {
  parentId?: string;
  recursive?: boolean;
  search?: string;
  includeTypes?: string[];
  excludeTypes?: string[];
  ids?: string[];
  favorite?: boolean;
  played?: boolean;
  resumable?: boolean;
  sortBy?: string;
  descending?: boolean;
  start?: number;
  limit?: number;
}

const ticks = (seconds: number) => Math.max(0, Math.round(seconds * 10_000_000));
const seconds = (value: number) => Math.max(0, value / 10_000_000);
const hashId = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
const nameCollator = new Intl.Collator('zh-CN');
/** Most titles (and milliseconds) per backend-move transaction: about a thousand rows, briefly blocking each. */
const rebaseBatchTitles = 50;
/** Rows added to the search index per transaction while it is built in the background (about 40 ms each). */
const searchIndexBatchRows = 2000;
const rebaseBatchMs = 40;
/** Let queued requests run between the batches of a long catalog rewrite. */
export const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

function mediaType(item: Pick<MediaItem, 'mediaType'>): 'Series' | 'Movie' {
  return /movie|film|video/i.test(item.mediaType || '') ? 'Movie' : 'Series';
}

/** Point a backend provider detail link at another backend root; other links are returned unchanged. */
export function rebaseProviderLink(sourceId: string, link: string, backend: string): string {
  const match = /^https?:\/\/[^/?#]+(?:\/[^?#]*)?(\/api\/v1\/providers\/([^/?#]+)\/items\/[^/?#]+)$/.exec(link);
  return match && match[2] === sourceId ? backend.replace(/\/$/, '') + match[1] : link;
}

export class Catalog {
  readonly db: DatabaseSync;
  readonly serverId: string;
  private readonly putItem: StatementSync;
  /** Bumped on every write that can change which items a query matches or how they sort by name. */
  private revision = 0;
  /** Whether every catalog row is in the trigram search index. */
  private searchReady = false;
  /** Recently collated name orders, so paging through a large name-sorted listing sorts it only once. */
  private readonly nameOrders = new Map<string, { ids: string[]; revision: number; expires: number }>();

  constructor(readonly accounts: AccountDatabase) {
    this.db = accounts.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS emby_tokens (
        tokenHash TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        deviceId TEXT NOT NULL,
        client TEXT NOT NULL,
        deviceName TEXT NOT NULL,
        version TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        lastUsedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS emby_tokens_user ON emby_tokens(userId);
      CREATE TABLE IF NOT EXISTS media_items (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('CollectionFolder','Series','Season','Episode','Movie')),
        parentId TEXT NOT NULL,
        link TEXT NOT NULL,
        upstreamId TEXT NOT NULL,
        name TEXT NOT NULL,
        overview TEXT NOT NULL,
        posterUrl TEXT NOT NULL,
        indexNumber INTEGER,
        parentIndexNumber INTEGER,
        mediaType TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        detailAt INTEGER NOT NULL,
        available INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS media_items_parent ON media_items(parentId, type, name);
      CREATE INDEX IF NOT EXISTS media_items_source ON media_items(sourceId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS media_items_link ON media_items(sourceId, link, type);
      -- Never queried, and its unindexed id made every catalog write scan the whole index.
      DROP TABLE IF EXISTS media_items_fts;
      CREATE TABLE IF NOT EXISTS user_item_data (
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        itemId TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        favorite INTEGER NOT NULL DEFAULT 0,
        played INTEGER NOT NULL DEFAULT 0,
        playCount INTEGER NOT NULL DEFAULT 0,
        positionTicks INTEGER NOT NULL DEFAULT 0,
        runtimeTicks INTEGER NOT NULL DEFAULT 0,
        lastPlayedAt INTEGER,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY(userId, itemId)
      );
      CREATE INDEX IF NOT EXISTS user_item_resume ON user_item_data(userId, positionTicks, lastPlayedAt DESC);
      -- Deleting a catalog row checks this foreign key; without the index every delete scans the whole table.
      CREATE INDEX IF NOT EXISTS user_item_data_item ON user_item_data(itemId);
      CREATE TABLE IF NOT EXISTS catalog_sync (
        sourceId TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        scannedItems INTEGER NOT NULL,
        lastStartedAt INTEGER,
        lastCompletedAt INTEGER,
        error TEXT NOT NULL
      );
    `);
    // Covers type-filtered counts, date pages, name projections and searches, so they never read the (very large) table rows.
    // Building it sorts every catalog row, which overflows the container's small /tmp tmpfs; sort in memory instead.
    this.db.exec('PRAGMA temp_store = MEMORY');
    try { this.db.exec('CREATE INDEX IF NOT EXISTS media_items_type ON media_items(type, available, sourceId, createdAt, id, name, overview)'); }
    finally { this.db.exec('PRAGMA temp_store = DEFAULT'); }
    this.createSearchIndex();
    const state = this.db.prepare("SELECT value FROM server_state WHERE key = 'serverId'").get() as { value: string } | undefined;
    this.serverId = state?.value || randomUUID().replaceAll('-', '');
    if (!state) this.db.prepare("INSERT INTO server_state VALUES ('serverId', ?)").run(this.serverId);
    this.putItem = this.db.prepare(`
      INSERT INTO media_items (id, sourceId, type, parentId, link, upstreamId, name, overview, posterUrl, indexNumber, parentIndexNumber, mediaType, createdAt, updatedAt, detailAt, available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        parentId = excluded.parentId, link = excluded.link, upstreamId = excluded.upstreamId,
        name = excluded.name, overview = excluded.overview, posterUrl = CASE WHEN excluded.posterUrl <> '' THEN excluded.posterUrl ELSE media_items.posterUrl END,
        indexNumber = excluded.indexNumber, parentIndexNumber = excluded.parentIndexNumber,
        mediaType = excluded.mediaType, updatedAt = excluded.updatedAt,
        detailAt = MAX(media_items.detailAt, excluded.detailAt), available = 1
    `);
    this.ensureLibraries();
    this.migrateLegacy();
  }

  /**
   * Trigram full-text index over names and overviews; substring searches of three or more characters read only matching
   * rows instead of scanning the whole catalog. Rows in (indexed, target] predate the index and are still being added
   * in the background (see buildSearchIndex); the triggers maintain every other row, so no row is indexed twice.
   * Unchanged upserts write nothing: the update trigger only fires when the text changes.
   */
  private createSearchIndex(): void {
    if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'media_search_state'").get()) {
      this.searchReady = this.searchIndexPending() === 0;
      return;
    }
    const indexed = 'FROM media_search_state WHERE id = 1';
    this.accounts.transaction(() => this.db.exec(`
      CREATE VIRTUAL TABLE media_search USING fts5(name, overview, content='media_items', content_rowid='rowid', tokenize='trigram');
      CREATE TABLE media_search_state (id INTEGER PRIMARY KEY CHECK (id = 1), indexed INTEGER NOT NULL, target INTEGER NOT NULL);
      INSERT INTO media_search_state SELECT 1, 0, COALESCE(MAX(rowid), 0) FROM media_items;
      CREATE TRIGGER media_search_insert AFTER INSERT ON media_items
        WHEN (SELECT new.rowid <= indexed OR new.rowid > target ${indexed})
      BEGIN
        INSERT INTO media_search(rowid, name, overview) VALUES (new.rowid, new.name, new.overview);
      END;
      CREATE TRIGGER media_search_delete AFTER DELETE ON media_items
        WHEN (SELECT old.rowid <= indexed OR old.rowid > target ${indexed})
      BEGIN
        INSERT INTO media_search(media_search, rowid, name, overview) VALUES ('delete', old.rowid, old.name, old.overview);
      END;
      CREATE TRIGGER media_search_update AFTER UPDATE OF name, overview ON media_items
        WHEN (old.name IS NOT new.name OR old.overview IS NOT new.overview) AND (SELECT old.rowid <= indexed OR old.rowid > target ${indexed})
      BEGIN
        INSERT INTO media_search(media_search, rowid, name, overview) VALUES ('delete', old.rowid, old.name, old.overview);
        INSERT INTO media_search(rowid, name, overview) VALUES (new.rowid, new.name, new.overview);
      END;
    `));
    this.searchReady = this.searchIndexPending() === 0;
  }

  /** Catalog rows not yet in the search index (an upper bound: rowids can have gaps). */
  private searchIndexPending(): number {
    const state = this.db.prepare('SELECT indexed, target FROM media_search_state WHERE id = 1').get() as { indexed: number; target: number };
    return Math.max(0, state.target - state.indexed);
  }

  /**
   * Indexes rows that existed before the search index, in short transactions that yield to other work. Searches scan
   * the catalog as before until this completes; `stopped` ends the run early and the next start resumes it.
   */
  async buildSearchIndex(stopped: () => boolean = () => false, batchRows = searchIndexBatchRows): Promise<number> {
    let added = 0;
    const next = this.db.prepare(`SELECT MAX(rowid) AS last, COUNT(*) AS count FROM (SELECT rowid FROM media_items
      WHERE rowid > ?1 AND rowid <= ?2 ORDER BY rowid LIMIT ?3)`);
    const insert = this.db.prepare('INSERT INTO media_search(rowid, name, overview) SELECT rowid, name, overview FROM media_items WHERE rowid > ? AND rowid <= ?');
    const advance = this.db.prepare('UPDATE media_search_state SET indexed = ? WHERE id = 1');
    while (!this.searchReady) {
      if (stopped()) return added;
      added += this.accounts.transaction(() => {
        const { indexed, target } = this.db.prepare('SELECT indexed, target FROM media_search_state WHERE id = 1').get() as { indexed: number; target: number };
        const batch = next.get(indexed, target, batchRows) as { last: number | null; count: number };
        const last = batch.count < batchRows ? target : batch.last!;
        insert.run(indexed, last);
        advance.run(last);
        if (last >= target) this.searchReady = true;
        return batch.count;
      });
      await nextTurn();
    }
    return added;
  }

  static libraryId(sourceId: string): string { return hashId('library', sourceId); }
  static mediaId(sourceId: string, link: string, type: 'Series' | 'Movie' = 'Series'): string { return hashId(type, sourceId, link); }
  static seasonId(seriesId: string, seasonNumber: number): string { return hashId('Season', seriesId, String(seasonNumber)); }
  static episodeId(seriesId: string, upstreamId: string): string { return hashId('Episode', seriesId, upstreamId); }
  static tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

  ensureLibraries(): void {
    const now = Date.now();
    for (const source of sourceEntries()) {
      this.upsert({
        id: Catalog.libraryId(source.id), sourceId: source.id, type: 'CollectionFolder', parentId: '', link: '', upstreamId: source.id,
        name: source.title, overview: '', posterUrl: '', indexNumber: null, parentIndexNumber: null,
        mediaType: 'Video', createdAt: now, updatedAt: now, detailAt: now, available: 1,
      });
      this.db.prepare("INSERT INTO catalog_sync VALUES (?, 'idle', 0, NULL, NULL, '') ON CONFLICT(sourceId) DO NOTHING").run(source.id);
    }
  }

  private migrateLegacy(): void {
    const marker = this.db.prepare("SELECT value FROM server_state WHERE key = 'catalogLegacyMigration'").get();
    if (marker) return;
    this.accounts.transaction(() => {
      const favorites = this.db.prepare('SELECT userId, record FROM favorites').all() as { userId: string; record: string }[];
      for (const row of favorites) {
        const record = JSON.parse(row.record) as FavoriteRecord;
        const item = this.ensureMedia(record);
        this.patchUserData(row.userId, item.id, { favorite: true, updatedAt: record.savedAt });
      }
      const recent = this.db.prepare('SELECT userId, record FROM recent').all() as { userId: string; record: string }[];
      for (const row of recent) {
        const record = JSON.parse(row.record) as RecentRecord;
        this.ingestLegacyProgress(row.userId, record);
      }
      const watches = this.db.prepare('SELECT userId, record FROM watches').all() as { userId: string; record: string }[];
      for (const row of watches) this.ingestLegacyProgress(row.userId, JSON.parse(row.record) as WatchRecord);
      this.db.prepare("INSERT INTO server_state VALUES ('catalogLegacyMigration', ?)").run(String(Date.now()));
    });
  }

  ensureMedia(record: Pick<FavoriteRecord, 'sourceId' | 'link' | 'mediaId' | 'title' | 'posterUrl'>): CatalogItem {
    const existing = this.findMedia(record.sourceId, record.link);
    const id = existing?.id || Catalog.mediaId(record.sourceId, record.link);
    const now = Date.now();
    const item: CatalogItem = existing || {
      id, sourceId: record.sourceId, type: 'Series', parentId: Catalog.libraryId(record.sourceId), link: record.link,
      upstreamId: record.mediaId, name: record.title, overview: '', posterUrl: record.posterUrl,
      indexNumber: null, parentIndexNumber: null, mediaType: 'Video', createdAt: now, updatedAt: now, detailAt: 0, available: 1,
    };
    this.upsert({ ...item, name: record.title, posterUrl: record.posterUrl || item.posterUrl, updatedAt: now });
    return item;
  }

  private ingestLegacyProgress(userId: string, record: RecentRecord | WatchRecord): void {
    const parent = this.ensureMedia(record);
    const episodeId = Catalog.episodeId(parent.id, record.episodeId);
    const now = record.updatedAt || Date.now();
    this.upsert({
      id: episodeId, sourceId: record.sourceId, type: 'Episode', parentId: parent.id, link: record.link,
      upstreamId: record.episodeId, name: record.episodeTitle, overview: '', posterUrl: record.posterUrl,
      indexNumber: null, parentIndexNumber: null, mediaType: 'Video', createdAt: now, updatedAt: now, detailAt: 0, available: 1,
    });
    this.patchUserData(userId, episodeId, { positionTicks: ticks(record.position), runtimeTicks: ticks(record.duration), lastPlayedAt: now, updatedAt: now });
  }

  upsert(item: CatalogItem): void {
    this.revision++;
    this.putItem.run(item.id, item.sourceId, item.type, item.parentId, item.link, item.upstreamId, item.name, item.overview,
      item.posterUrl, item.indexNumber, item.parentIndexNumber, item.mediaType, item.createdAt, item.updatedAt, item.detailAt);
  }

  ingestBrowse(result: BrowseResult): CatalogItem[] {
    const now = Date.now();
    return result.items.map(item => {
      const type = mediaType(item);
      const row: CatalogItem = {
        id: Catalog.mediaId(item.sourceId, item.link, type), sourceId: item.sourceId, type,
        parentId: Catalog.libraryId(item.sourceId), link: item.link, upstreamId: item.id,
        name: item.title, overview: item.description || '', posterUrl: item.posterUrl,
        indexNumber: null, parentIndexNumber: null, mediaType: item.mediaType || 'Video',
        createdAt: now, updatedAt: now, detailAt: 0, available: 1,
      };
      this.upsert(row);
      return this.get(row.id)!;
    });
  }

  ingestDetail(detail: Detail): CatalogItem {
    const now = Date.now();
    const type = mediaType(detail);
    const seriesId = Catalog.mediaId(detail.sourceId, detail.link, type);
    const series: CatalogItem = {
      id: seriesId, sourceId: detail.sourceId, type, parentId: Catalog.libraryId(detail.sourceId), link: detail.link,
      upstreamId: detail.id, name: detail.title, overview: detail.description || '', posterUrl: detail.posterUrl,
      indexNumber: null, parentIndexNumber: null, mediaType: detail.mediaType || 'Video',
      createdAt: this.get(seriesId)?.createdAt || now, updatedAt: now, detailAt: now, available: 1,
    };
    this.accounts.transaction(() => {
      this.db.prepare(`UPDATE media_items SET available = 0 WHERE parentId = ? OR parentId IN
        (SELECT id FROM media_items WHERE parentId = ?)`).run(seriesId, seriesId);
      this.upsert(series);
      if (type === 'Series') {
        for (const season of detail.seasons) {
          const seasonId = Catalog.seasonId(seriesId, season.seasonNumber);
          this.upsert({
            id: seasonId, sourceId: detail.sourceId, type: 'Season', parentId: seriesId, link: detail.link,
            upstreamId: String(season.seasonNumber), name: season.title || `第 ${season.seasonNumber} 季`, overview: '', posterUrl: detail.posterUrl,
            indexNumber: season.seasonNumber, parentIndexNumber: null, mediaType: 'Video', createdAt: now, updatedAt: now, detailAt: now, available: 1,
          });
          for (const episode of season.episodes) {
            this.upsert({
              id: Catalog.episodeId(seriesId, episode.id), sourceId: detail.sourceId, type: 'Episode', parentId: seasonId,
              link: detail.link, upstreamId: episode.id, name: episode.title, overview: '', posterUrl: detail.posterUrl,
              indexNumber: number(episode.episodeNumber), parentIndexNumber: season.seasonNumber, mediaType: 'Video',
              createdAt: now, updatedAt: now, detailAt: now, available: 1,
            });
          }
        }
      } else if (detail.episodeItems[0]) {
        const episode = detail.episodeItems[0];
        this.upsert({
          id: Catalog.episodeId(seriesId, episode.id), sourceId: detail.sourceId, type: 'Episode', parentId: seriesId,
          link: detail.link, upstreamId: episode.id, name: detail.title, overview: detail.description || '', posterUrl: detail.posterUrl,
          indexNumber: 1, parentIndexNumber: 1, mediaType: 'Video', createdAt: now, updatedAt: now, detailAt: now, available: 1,
        });
      }
    });
    return this.get(seriesId)!;
  }

  get(id: string): CatalogItem | undefined {
    return this.db.prepare('SELECT * FROM media_items WHERE id = ?').get(id) as unknown as CatalogItem | undefined;
  }

  findMedia(sourceId: string, link: string): CatalogItem | undefined {
    return this.db.prepare("SELECT * FROM media_items WHERE sourceId = ? AND link = ? AND type IN ('Series','Movie') ORDER BY detailAt DESC LIMIT 1").get(sourceId, link) as unknown as CatalogItem | undefined;
  }
  cachedDetail(sourceId: string, link: string): Detail | undefined {
    const parent = this.findMedia(sourceId, link);
    if (!parent || parent.detailAt === 0) return undefined;
    const episode = (item: CatalogItem) => ({
      id: item.upstreamId,
      title: item.name,
      episodeNumber: item.indexNumber ?? undefined,
      seasonNumber: item.parentIndexNumber ?? 1,
      videoUrl: '',
      link: item.link,
    });
    const seasonRows = parent.type === 'Series' ? this.children(parent.id).filter(item => item.type === 'Season') : [];
    const seasons = seasonRows.map(season => ({
      seasonNumber: season.indexNumber ?? 1,
      title: season.name,
      episodes: this.children(season.id).filter(item => item.type === 'Episode').map(episode),
    }));
    const episodeItems = parent.type === 'Movie'
      ? this.children(parent.id).filter(item => item.type === 'Episode').map(episode)
      : seasons.flatMap(season => season.episodes);
    if (!episodeItems.length) return undefined;
    return {
      id: parent.upstreamId,
      sourceId: parent.sourceId,
      title: parent.name,
      posterUrl: parent.posterUrl,
      description: parent.overview,
      link: parent.link,
      mediaType: parent.mediaType,
      seasons,
      episodeItems,
    };
  }

  /**
   * Move titles saved from an earlier backend onto the current one. Ids derive from links, so each title's
   * subtree is re-keyed; when the new title already exists the two are merged, keeping user data.
   * A large catalog holds about a million rows, so titles move in short transactions that yield to the event
   * loop in between; `stopped` ends the run early (e.g. the backend changed again) with the rest left for later.
   */
  async rebaseBackend(backend: string, posterUrl: (sourceId: string, link: string) => string, stopped: () => boolean = () => false): Promise<number> {
    if (!backend) return 0;
    const titles = this.db.prepare("SELECT id, sourceId, type, link FROM media_items WHERE type IN ('Series','Movie') AND link LIKE '%/api/v1/providers/%'")
      .all() as Pick<CatalogItem, 'id' | 'sourceId' | 'type' | 'link'>[];
    const children = this.db.prepare('SELECT * FROM media_items WHERE parentId = ?');
    const childCount = this.db.prepare('SELECT count(*) AS count FROM media_items WHERE parentId = ?');
    const insert = this.db.prepare('INSERT INTO media_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const remove = this.db.prepare('DELETE FROM media_items WHERE id = ?');
    const moveData = this.db.prepare(`INSERT INTO user_item_data (userId, itemId, favorite, played, playCount, positionTicks, runtimeTicks, lastPlayedAt, updatedAt)
      SELECT userId, ?, favorite, played, playCount, positionTicks, runtimeTicks, lastPlayedAt, updatedAt FROM user_item_data WHERE itemId = ?
      ON CONFLICT(userId, itemId) DO UPDATE SET favorite = MAX(favorite, excluded.favorite), played = MAX(played, excluded.played),
        playCount = MAX(playCount, excluded.playCount), runtimeTicks = MAX(runtimeTicks, excluded.runtimeTicks),
        positionTicks = CASE WHEN excluded.updatedAt > updatedAt THEN excluded.positionTicks ELSE positionTicks END,
        lastPlayedAt = NULLIF(MAX(COALESCE(lastPlayedAt, 0), COALESCE(excluded.lastPlayedAt, 0)), 0),
        updatedAt = MAX(updatedAt, excluded.updatedAt)`);
    const pending = titles.filter(title => rebaseProviderLink(title.sourceId, title.link, backend) !== title.link);
    let moved = 0;
    for (let next = 0; next < pending.length;) {
      if (stopped()) return moved;
      if (next) await nextTurn();
      this.revision++;
      const first = next;
      const started = performance.now();
      moved += this.accounts.transaction(() => {
        let batch = 0;
        // A batch also ends on its time budget, so titles with thousands of episodes cannot stall the server.
        for (; next < pending.length && next - first < rebaseBatchTitles && (next === first || performance.now() - started < rebaseBatchMs); next++) {
          const title = pending[next]!;
          const link = rebaseProviderLink(title.sourceId, title.link, backend);
          // Catalog sync may have changed or removed the title while earlier batches ran.
          const root = this.get(title.id);
          if (!root || root.link !== title.link) continue;
          const rootId = Catalog.mediaId(title.sourceId, link, title.type as 'Series' | 'Movie');
          // Keep an already detailed target's own episode list; otherwise carry the old one over.
          const fill = !(childCount.get(rootId) as { count: number }).count;
          const ids = new Map([[root.id, rootId]]);
          const poster = root.posterUrl ? posterUrl(title.sourceId, link) : '';
          const direct = children.all(root.id) as unknown as CatalogItem[];
          const seasons = direct.filter(row => row.type === 'Season');
          const rows = [root, ...seasons, ...direct.filter(row => row.type !== 'Season'),
            ...seasons.flatMap(season => children.all(season.id) as unknown as CatalogItem[])];
          for (const row of rows) {
            const id = row === root ? rootId : row.type === 'Season' ? Catalog.seasonId(rootId, Number(row.upstreamId)) : Catalog.episodeId(rootId, row.upstreamId);
            ids.set(row.id, id);
            if (!this.get(id) && (row === root || fill)) {
              insert.run(id, row.sourceId, row.type, row === root ? row.parentId : ids.get(row.parentId)!, link, row.upstreamId, row.name, row.overview,
                row.posterUrl ? poster : '', row.indexNumber, row.parentIndexNumber, row.mediaType, row.createdAt, row.updatedAt, row.detailAt, row.available);
            }
            if (this.get(id)) moveData.run(id, row.id);
          }
          for (const row of rows.reverse()) remove.run(row.id);
          batch++;
        }
        return batch;
      });
    }
    if (stopped()) return moved;
    this.accounts.transaction(() => this.rebaseLegacyRecords(backend, posterUrl));
    return moved;
  }

  /** Whether any title still links into a backend other than `backend`, i.e. whether a move has work to do. */
  hasForeignTitles(backend: string): boolean {
    if (!backend) return false;
    return !!this.db.prepare(`SELECT 1 FROM media_items WHERE type IN ('Series','Movie') AND link LIKE '%/api/v1/providers/%'
      AND substr(link, 1, ?) <> ? LIMIT 1`).get(backend.length + 1, `${backend}/`);
  }

  private rebaseLegacyRecords(backend: string, posterUrl: (sourceId: string, link: string) => string): void {
    const rebase = <T extends { sourceId: string; link: string; posterUrl: string }>(record: T): T | undefined => {
      const link = rebaseProviderLink(record.sourceId, record.link, backend);
      return link === record.link ? undefined : { ...record, link, posterUrl: record.posterUrl ? posterUrl(record.sourceId, link) : '' };
    };
    for (const row of this.db.prepare('SELECT userId, key, record FROM watches').all() as { userId: string; key: string; record: string }[]) {
      const watch = rebase(JSON.parse(row.record) as WatchRecord);
      if (!watch) continue;
      watch.key = episodeKey(watch.sourceId, watch.link, watch.episodeId);
      watch.mediaKey = recordKey(watch.sourceId, watch.link);
      this.db.prepare('DELETE FROM watches WHERE userId = ? AND key = ?').run(row.userId, row.key);
      this.db.prepare(`INSERT INTO watches VALUES (?, ?, ?, ?, ?) ON CONFLICT(userId, key) DO UPDATE SET
        mediaKey = excluded.mediaKey, record = excluded.record, updatedAt = excluded.updatedAt WHERE excluded.updatedAt > watches.updatedAt`)
        .run(row.userId, watch.key, watch.mediaKey, JSON.stringify(watch), watch.updatedAt);
    }
    for (const row of this.db.prepare('SELECT userId, key, record FROM recent').all() as { userId: string; key: string; record: string }[]) {
      const recent = rebase(JSON.parse(row.record) as RecentRecord);
      if (!recent) continue;
      recent.key = recordKey(recent.sourceId, recent.link);
      this.db.prepare('DELETE FROM recent WHERE userId = ? AND key = ?').run(row.userId, row.key);
      this.db.prepare(`INSERT INTO recent VALUES (?, ?, ?, ?) ON CONFLICT(userId, key) DO UPDATE SET
        record = excluded.record, updatedAt = excluded.updatedAt WHERE excluded.updatedAt > recent.updatedAt`)
        .run(row.userId, recent.key, JSON.stringify(recent), recent.updatedAt);
    }
    for (const row of this.db.prepare('SELECT userId, key, record FROM favorites').all() as { userId: string; key: string; record: string }[]) {
      const favorite = rebase(JSON.parse(row.record) as FavoriteRecord);
      if (!favorite) continue;
      favorite.key = recordKey(favorite.sourceId, favorite.link);
      this.db.prepare('DELETE FROM favorites WHERE userId = ? AND key = ?').run(row.userId, row.key);
      this.db.prepare('INSERT INTO favorites VALUES (?, ?, ?, ?) ON CONFLICT(userId, key) DO NOTHING')
        .run(row.userId, favorite.key, JSON.stringify(favorite), favorite.savedAt);
    }
  }

  /** Re-point stored poster URLs at the current backend's poster ids (they include the backend root), in short batches. */
  async refreshPosterUrls(posterUrl: (sourceId: string, link: string) => string, stopped: () => boolean = () => false): Promise<number> {
    const titles = this.db.prepare("SELECT id, sourceId, link, posterUrl FROM media_items WHERE type IN ('Series','Movie') AND posterUrl LIKE '/api/posters/%'")
      .all() as Pick<CatalogItem, 'id' | 'sourceId' | 'link' | 'posterUrl'>[];
    const update = this.db.prepare('UPDATE media_items SET posterUrl = ?1 WHERE posterUrl = ?2 AND id = ?3');
    const updateChildren = this.db.prepare('UPDATE media_items SET posterUrl = ?1 WHERE posterUrl = ?2 AND parentId = ?3 RETURNING id, type');
    const pending = titles.flatMap(title => {
      const expected = posterUrl(title.sourceId, title.link);
      return expected && expected !== title.posterUrl ? [{ ...title, expected }] : [];
    });
    for (let start = 0; start < pending.length; start += rebaseBatchTitles) {
      if (stopped()) return start;
      if (start) await nextTurn();
      this.accounts.transaction(() => {
        for (const title of pending.slice(start, start + rebaseBatchTitles)) {
          update.run(title.expected, title.posterUrl, title.id);
          for (const child of updateChildren.all(title.expected, title.posterUrl, title.id) as { id: string; type: string }[]) {
            if (child.type === 'Season') updateChildren.all(title.expected, title.posterUrl, child.id);
          }
        }
      });
    }
    return pending.length;
  }

  needsDetail(item: CatalogItem, maxAge: number): boolean {
    return item.detailAt === 0 || Date.now() - item.detailAt >= maxAge || !this.cachedDetail(item.sourceId, item.link);
  }

  children(parentId: string): CatalogItem[] {
    return this.db.prepare('SELECT * FROM media_items WHERE parentId = ? AND available = 1 ORDER BY COALESCE(indexNumber, 2147483647), name').all(parentId) as unknown as CatalogItem[];
  }

  findSeries(item: CatalogItem): CatalogItem | undefined {
    if (item.type === 'Series' || item.type === 'Movie') return item;
    const parent = this.get(item.parentId);
    return parent?.type === 'Season' ? this.get(parent.parentId) : parent;
  }

  query(user: User, query: CatalogQuery): { items: CatalogItem[]; total: number } {
    // Filter, count and page in SQLite: the catalog can hold hundreds of thousands of rows,
    // and materialising them all per request exhausts the Node heap.
    const allowed = user.role === 'admin' ? knownSourceIds() : user.sourceIds;
    if (!allowed.length) return { items: [], total: 0 };
    const where = ['m.available = 1', `m.sourceId IN (${allowed.map(() => '?').join(',')})`];
    const params: SQLInputValue[] = [...allowed];
    let tree = '';
    let treeParent: string | undefined;
    if (query.parentId !== undefined) {
      if (!query.recursive) {
        where.push('m.parentId = ?');
        params.push(query.parentId);
      } else if (this.get(query.parentId)?.type === 'CollectionFolder') {
        // A library holds exactly its source's items, so the indexed sourceId replaces the tree walk.
        where.push('m.sourceId = (SELECT sourceId FROM media_items WHERE id = ?)', 'm.id <> ?');
        params.push(query.parentId, query.parentId);
      } else if (query.parentId !== '') {
        tree = `WITH RECURSIVE tree(id) AS (SELECT id FROM media_items WHERE parentId = ? AND +available = 1
          UNION ALL SELECT child.id FROM media_items child JOIN tree ON child.parentId = tree.id WHERE +child.available = 1) `;
        treeParent = query.parentId;
        where.push('m.id IN (SELECT id FROM tree)');
      }
    } else if (!query.recursive) where.push("m.type = 'CollectionFolder'");
    const list = (column: string, values: string[], negate = false) => {
      where.push(`${column} ${negate ? 'NOT IN' : 'IN'} (${values.map(() => '?').join(',')})`);
      params.push(...values);
    };
    // Emby item types are case-insensitive (clients send e.g. IncludeItemTypes=series); stored types are canonical.
    const types = (values: string[]) => values.map(value => catalogItemTypes.find(type => type.toLowerCase() === value.toLowerCase()) ?? value);
    if (query.ids?.length) list('m.id', query.ids);
    if (query.includeTypes?.length) list('m.type', types(query.includeTypes));
    // Naming every type keeps the type-led covering index usable for untyped recursive listings and searches.
    else if (query.recursive && !tree) list('m.type', [...catalogItemTypes]);
    if (query.excludeTypes?.length) list('m.type', types(query.excludeTypes), true);
    let source = 'media_items m';
    if (query.search) {
      const needle = query.search.toLocaleLowerCase();
      // Trigrams cannot index shorter needles. The index only narrows candidates; instr() keeps the matching rules.
      if (this.searchReady && [...needle].length >= 3) {
        source = 'media_search s CROSS JOIN media_items m ON m.rowid = s.rowid';
        where.push('media_search MATCH ?');
        params.push(`"${needle.replaceAll('"', '""')}"`);
      }
      where.push('(instr(lower(m.name), ?) > 0 OR instr(lower(m.overview), ?) > 0)');
      params.push(needle, needle);
    }
    const byPlayed = /DatePlayed/i.test(query.sortBy || '');
    // Filters that need a user row let SQLite start from the user's few rows instead of joining every catalog item.
    const required = query.favorite === true || query.played === true || query.resumable === true;
    const join = required || query.favorite !== undefined || query.played !== undefined || query.resumable !== undefined || byPlayed
      ? `${required ? '' : 'LEFT '}JOIN user_item_data d ON d.userId = ? AND d.itemId = m.id` : '';
    if (query.favorite !== undefined) where.push(`COALESCE(d.favorite, 0) ${query.favorite ? '<>' : '='} 0`);
    if (query.played !== undefined) where.push(`COALESCE(d.played, 0) ${query.played ? '<>' : '='} 0`);
    if (query.resumable !== undefined) where.push(`${query.resumable ? '' : 'NOT '}COALESCE(d.positionTicks > 0 AND d.played = 0, 0)`);
    if (join) params.unshift(user.id);
    if (treeParent !== undefined) params.unshift(treeParent);
    const from = `${tree}SELECT %s FROM ${source} ${join} WHERE ${where.join(' AND ')}`;
    const total = (this.db.prepare(from.replace('%s', 'count(*) AS total')).get(...params) as { total: number }).total;
    const start = Math.max(0, query.start || 0);
    const limit = Math.min(1000, Math.max(0, query.limit ?? 100));
    if (!limit || start >= total) return { items: [], total };
    const direction = query.descending ? 'DESC' : 'ASC';
    let ids: string[];
    if (/DateCreated|DateLastContentAdded/i.test(query.sortBy || '') || byPlayed) {
      const column = byPlayed ? 'COALESCE(d.lastPlayedAt, 0)' : 'm.createdAt';
      ids = (this.db.prepare(`${from.replace('%s', 'm.id')} ORDER BY ${column} ${direction}, m.id LIMIT ? OFFSET ?`)
        .all(...params, limit, start) as { id: string }[]).map(row => row.id);
    } else if (/Random/i.test(query.sortBy || '')) {
      ids = (this.db.prepare(`${from.replace('%s', 'm.id')} ORDER BY random() LIMIT ? OFFSET ?`)
        .all(...params, limit, start) as { id: string }[]).map(row => row.id);
    } else {
      ids = this.nameOrder(from.replace('%s', 'm.id, m.name'), params, !!query.descending).slice(start, start + limit);
    }
    if (!ids.length) return { items: [], total };
    const rows = this.db.prepare(`SELECT * FROM media_items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as CatalogItem[];
    const byId = new Map(rows.map(row => [row.id, row]));
    return { items: ids.flatMap(id => byId.get(id) ?? []), total };
  }

  /** Pinyin-aware name order is not available as an SQLite collation; sort only the id/name projection. */
  private nameOrder(sql: string, params: SQLInputValue[], descending: boolean): string[] {
    const key = JSON.stringify([sql, params, descending]);
    const cached = this.nameOrders.get(key);
    if (cached && cached.revision === this.revision && cached.expires > Date.now()) return cached.ids;
    const names = this.db.prepare(sql).all(...params) as { id: string; name: string }[];
    const order = descending ? -1 : 1;
    names.sort((a, b) => order * nameCollator.compare(a.name, b.name));
    const ids = names.map(row => row.id);
    this.nameOrders.delete(key);
    while (this.nameOrders.size >= 4) this.nameOrders.delete(this.nameOrders.keys().next().value!);
    this.nameOrders.set(key, { ids, revision: this.revision, expires: Date.now() + 60_000 });
    return ids;
  }

  userData(userId: string, itemId: string): UserItemData | undefined {
    return this.db.prepare('SELECT * FROM user_item_data WHERE userId = ? AND itemId = ?').get(userId, itemId) as unknown as UserItemData | undefined;
  }

  patchUserData(userId: string, itemId: string, patch: { favorite?: boolean; played?: boolean; positionTicks?: number; runtimeTicks?: number; lastPlayedAt?: number | null; updatedAt?: number }): UserItemData {
    const now = patch.updatedAt || Date.now();
    const current = this.userData(userId, itemId);
    const played = patch.played === undefined ? current?.played || 0 : Number(patch.played);
    const position = patch.positionTicks === undefined ? current?.positionTicks || 0 : Math.max(0, patch.positionTicks);
    const runtime = patch.runtimeTicks === undefined ? current?.runtimeTicks || 0 : Math.max(0, patch.runtimeTicks);
    const next: UserItemData = {
      userId, itemId,
      favorite: patch.favorite === undefined ? current?.favorite || 0 : Number(patch.favorite),
      played,
      playCount: current?.playCount || 0,
      positionTicks: played ? 0 : position,
      runtimeTicks: runtime,
      lastPlayedAt: patch.lastPlayedAt === undefined ? current?.lastPlayedAt || null : patch.lastPlayedAt,
      updatedAt: now,
    };
    if (patch.played && !current?.played) next.playCount++;
    this.revision++;
    this.db.prepare(`INSERT INTO user_item_data VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(userId, itemId) DO UPDATE SET favorite=excluded.favorite, played=excluded.played, playCount=excluded.playCount,
      positionTicks=excluded.positionTicks, runtimeTicks=excluded.runtimeTicks, lastPlayedAt=excluded.lastPlayedAt, updatedAt=excluded.updatedAt`)
      .run(next.userId, next.itemId, next.favorite, next.played, next.playCount, next.positionTicks, next.runtimeTicks, next.lastPlayedAt, next.updatedAt);
    return next;
  }

  saveWatchRecord(userId: string, record: WatchRecord): void {
    const parent = this.ensureMedia(record);
    const itemId = Catalog.episodeId(parent.id, record.episodeId);
    if (!this.get(itemId)) {
      this.upsert({
        id: itemId, sourceId: record.sourceId, type: 'Episode', parentId: parent.id, link: record.link,
        upstreamId: record.episodeId, name: record.episodeTitle, overview: '', posterUrl: record.posterUrl,
        indexNumber: null, parentIndexNumber: null, mediaType: 'Video', createdAt: record.updatedAt,
        updatedAt: record.updatedAt, detailAt: 0, available: 1,
      });
    }
    const completed = record.duration > 0 && record.position >= record.duration - 2;
    this.patchUserData(userId, itemId, {
      played: completed,
      positionTicks: ticks(record.position),
      runtimeTicks: ticks(record.duration),
      lastPlayedAt: record.updatedAt,
      updatedAt: record.updatedAt,
    });
  }

  setFavoriteRecord(userId: string, record: Pick<FavoriteRecord, 'sourceId' | 'link' | 'mediaId' | 'title' | 'posterUrl'>, favorite: boolean): void {
    const item = this.ensureMedia(record);
    this.patchUserData(userId, item.id, { favorite });
  }

  clearLegacyData(userId: string, sourceIds: readonly string[], kind: 'history' | 'favorites'): void {
    if (!sourceIds.length) return;
    const allowed = new Set(sourceIds);
    const rows = this.db.prepare(`SELECT user_item_data.itemId, media_items.sourceId FROM user_item_data
      JOIN media_items ON media_items.id = user_item_data.itemId WHERE user_item_data.userId = ?`).all(userId) as { itemId: string; sourceId: string }[];
    const update = kind === 'favorites'
      ? this.db.prepare('UPDATE user_item_data SET favorite = 0, updatedAt = ? WHERE userId = ? AND itemId = ?')
      : this.db.prepare('UPDATE user_item_data SET played = 0, positionTicks = 0, runtimeTicks = 0, lastPlayedAt = NULL, updatedAt = ? WHERE userId = ? AND itemId = ?');
    const now = Date.now();
    this.revision++;
    for (const row of rows) if (allowed.has(row.sourceId)) update.run(now, userId, row.itemId);
  }

  removeLegacyData(userId: string, sourceId: string, link: string, kind: 'history' | 'favorites'): void {
    const parent = this.findMedia(sourceId, link);
    if (!parent) return;
    const ids = new Set<string>([parent.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of this.db.prepare('SELECT id, parentId FROM media_items WHERE sourceId = ?').all(sourceId) as { id: string; parentId: string }[]) {
        if (ids.has(row.parentId) && !ids.has(row.id)) {
          ids.add(row.id);
          changed = true;
        }
      }
    }
    const statement = kind === 'favorites'
      ? this.db.prepare('UPDATE user_item_data SET favorite = 0, updatedAt = ? WHERE userId = ? AND itemId = ?')
      : this.db.prepare('UPDATE user_item_data SET played = 0, positionTicks = 0, runtimeTicks = 0, lastPlayedAt = NULL, updatedAt = ? WHERE userId = ? AND itemId = ?');
    const now = Date.now();
    this.revision++;
    for (const id of ids) statement.run(now, userId, id);
  }

  resume(user: User, limit = 20): CatalogItem[] {
    const allowed = new Set(user.role === 'admin' ? knownSourceIds() : user.sourceIds);
    return (this.db.prepare(`SELECT media_items.* FROM user_item_data JOIN media_items ON media_items.id = user_item_data.itemId
      WHERE user_item_data.userId = ? AND user_item_data.positionTicks > 0 AND user_item_data.played = 0 AND media_items.available = 1
      ORDER BY user_item_data.lastPlayedAt DESC LIMIT ?`).all(user.id, limit) as unknown as CatalogItem[]).filter(item => allowed.has(item.sourceId));
  }

  setSync(sourceId: string, state: 'idle' | 'scanning' | 'error', values: { scannedItems?: number; startedAt?: number | null; completedAt?: number | null; error?: string } = {}): void {
    const current = this.db.prepare('SELECT * FROM catalog_sync WHERE sourceId = ?').get(sourceId) as { scannedItems: number; lastStartedAt: number | null; lastCompletedAt: number | null; error: string } | undefined;
    this.db.prepare(`INSERT INTO catalog_sync VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sourceId) DO UPDATE SET state=excluded.state, scannedItems=excluded.scannedItems,
      lastStartedAt=excluded.lastStartedAt, lastCompletedAt=excluded.lastCompletedAt, error=excluded.error`)
      .run(sourceId, state, values.scannedItems ?? current?.scannedItems ?? 0, values.startedAt === undefined ? current?.lastStartedAt ?? null : values.startedAt,
        values.completedAt === undefined ? current?.lastCompletedAt ?? null : values.completedAt, values.error ?? current?.error ?? '');
  }

  syncStatus(): unknown[] { return this.db.prepare('SELECT * FROM catalog_sync ORDER BY sourceId').all(); }

  progressSeconds(userId: string, itemId: string): { position: number; duration: number } {
    const data = this.userData(userId, itemId);
    return { position: seconds(data?.positionTicks || 0), duration: seconds(data?.runtimeTicks || 0) };
  }
}
