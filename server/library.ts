import type { FastifyInstance } from 'fastify';
import { episodeKey, recordKey, toRecent, type FavoriteRecord, type RecentRecord, type WatchRecord } from '../src/storage.js';
import { canAccessSource, requireSourceAccess, type AccountDatabase, type User } from './accounts.js';
import { isKnownSource } from './source-registry.js';
import { ConfigError } from './config.js';
import type { Catalog } from './catalog.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('记录格式无效', 400);
  return value as Record<string, unknown>;
}
function text(row: Record<string, unknown>, field: string, max: number, optional = false): string {
  const value = row[field];
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || /[\u0000-\u001f]/.test(value)) throw new ConfigError(`记录字段 ${field} 无效`, 400);
  return value;
}
type PosterDecorator = <T extends Pick<FavoriteRecord, 'sourceId' | 'link' | 'title' | 'posterUrl'>>(item: T) => T;

export function registerLibraryRoutes(app: FastifyInstance, accounts: AccountDatabase, decoratePoster: PosterDecorator, catalog?: Catalog): void {
  const db = accounts.db;
  const listFavorites = db.prepare('SELECT record FROM favorites WHERE userId = ? ORDER BY savedAt DESC, key');
  const listRecent = db.prepare('SELECT record FROM recent WHERE userId = ? ORDER BY updatedAt DESC, key');
  const getWatch = db.prepare('SELECT record FROM watches WHERE userId = ? AND key = ?');
  const putWatch = db.prepare('INSERT INTO watches VALUES (?, ?, ?, ?, ?) ON CONFLICT(userId, key) DO UPDATE SET mediaKey = excluded.mediaKey, record = excluded.record, updatedAt = excluded.updatedAt');
  const putRecent = db.prepare('INSERT INTO recent VALUES (?, ?, ?, ?) ON CONFLICT(userId, key) DO UPDATE SET record = excluded.record, updatedAt = excluded.updatedAt');
  const getFavorite = db.prepare('SELECT key FROM favorites WHERE userId = ? AND key = ?');
  const putFavorite = db.prepare('INSERT INTO favorites VALUES (?, ?, ?, ?)');
  const removeFavorite = db.prepare('DELETE FROM favorites WHERE userId = ? AND key = ?');
  const removeRecent = db.prepare('DELETE FROM recent WHERE userId = ? AND key = ?');
  const removeWatches = db.prepare('DELETE FROM watches WHERE userId = ? AND mediaKey = ?');
  const clearFavorites = db.prepare("DELETE FROM favorites WHERE userId = ? AND json_extract(record, '$.sourceId') = ?");
  const clearRecent = db.prepare("DELETE FROM recent WHERE userId = ? AND json_extract(record, '$.sourceId') = ?");
  const clearWatches = db.prepare("DELETE FROM watches WHERE userId = ? AND json_extract(record, '$.sourceId') = ?");
  function mediaFields(value: unknown, user: User): Omit<FavoriteRecord, 'savedAt'> {
    const row = object(value);
    const sourceId = text(row, 'sourceId', 32);
    if (!isKnownSource(sourceId)) throw new ConfigError('未知视频源', 400);
    requireSourceAccess(user, sourceId);
    const link = text(row, 'link', 4096);
    const posterUrl = text(row, 'posterUrl', 4096, true);
    if (posterUrl) {
      let url: URL;
      try { url = new URL(posterUrl, 'https://local.invalid'); }
      catch { throw new ConfigError('封面地址无效', 400); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ConfigError('封面地址无效', 400);
    }
    return decoratePoster({ key: recordKey(sourceId, link), sourceId, mediaId: text(row, 'mediaId', 4096), link, title: text(row, 'title', 500), posterUrl });
  }
  function canonicalKey(value: unknown, user: User, episode = false): string {
    if (typeof value !== 'string' || value.length > 25000) throw new ConfigError('记录标识无效', 400);
    let parts: unknown;
    try { parts = JSON.parse(value); }
    catch { throw new ConfigError('记录标识无效', 400); }
    if (!Array.isArray(parts) || parts.length !== (episode ? 3 : 2) || parts.some(part => typeof part !== 'string' || !part.trim() || part.length > 4096 || /[\u0000-\u001f]/.test(part)) || !isKnownSource(parts[0])) throw new ConfigError('记录标识无效', 400);
    requireSourceAccess(user, parts[0]);
    return episode ? episodeKey(parts[0], parts[1], parts[2]) : recordKey(parts[0], parts[1]);
  }
  app.get('/api/library', async request => ({
    favorites: listFavorites.all(request.account!.id).map(row => JSON.parse(row.record as string) as FavoriteRecord).filter(row => canAccessSource(request.account, row.sourceId)).map(row => decoratePoster(row)),
    recent: listRecent.all(request.account!.id).map(row => JSON.parse(row.record as string) as RecentRecord).filter(row => canAccessSource(request.account, row.sourceId)).map(row => decoratePoster(row)),
  }));
  app.get<{ Querystring: { key?: string } }>('/api/library/watch', async request => {
    const row = getWatch.get(request.account!.id, canonicalKey(request.query.key, request.account!, true));
    return { watch: row ? decoratePoster(JSON.parse(row.record as string) as WatchRecord) : null };
  });
  app.post('/api/library/watch', async request => {
    const input = object(request.body);
    const media = mediaFields(input, request.account!);
    const episodeId = text(input, 'episodeId', 4096);
    const episodeTitle = text(input, 'episodeTitle', 500);
    const { position, duration } = input;
    if (typeof position !== 'number' || typeof duration !== 'number' || !Number.isFinite(position) || !Number.isFinite(duration) || position < 0 || duration < 0 || position > 31536000 || duration > 31536000) throw new ConfigError('播放进度无效', 400);
    const watch: WatchRecord = { ...media, key: episodeKey(media.sourceId, media.link, episodeId), mediaKey: media.key, episodeId, episodeTitle, position, duration, updatedAt: Date.now() };
    accounts.transaction(() => {
      putWatch.run(request.account!.id, watch.key, watch.mediaKey, JSON.stringify(watch), watch.updatedAt);
      putRecent.run(request.account!.id, watch.mediaKey, JSON.stringify(toRecent(watch)), watch.updatedAt);
      catalog?.saveWatchRecord(request.account!.id, watch);
    });
    return { watch };
  });
  app.post('/api/library/favorite', async request => {
    const media = mediaFields(object(request.body).record, request.account!);
    const userId = request.account!.id;
    return accounts.transaction(() => {
      if (getFavorite.get(userId, media.key)) {
        removeFavorite.run(userId, media.key);
        catalog?.setFavoriteRecord(userId, media, false);
        return { favorite: false };
      }
      const favorite: FavoriteRecord = { ...media, savedAt: Date.now() };
      putFavorite.run(userId, media.key, JSON.stringify(favorite), favorite.savedAt);
      catalog?.setFavoriteRecord(userId, favorite, true);
      return { favorite: true };
    });
  });
  app.post('/api/library/clear', async request => {
    const { kind } = object(request.body);
    const userId = request.account!.id;
    if (kind !== 'history' && kind !== 'favorites') throw new ConfigError('记录类型无效', 400);
    accounts.transaction(() => {
      for (const sourceId of request.account!.sourceIds) {
        if (kind === 'favorites') clearFavorites.run(userId, sourceId);
        else { clearRecent.run(userId, sourceId); clearWatches.run(userId, sourceId); }
      }
      catalog?.clearLegacyData(userId, request.account!.sourceIds, kind);
    });
    return { ok: true };
  });
  app.post('/api/library/remove', async request => {
    const { kind, key } = object(request.body);
    const userId = request.account!.id;
    if (kind !== 'history' && kind !== 'favorites') throw new ConfigError('记录类型无效', 400);
    const canonical = canonicalKey(key, request.account!);
    accounts.transaction(() => {
      if (kind === 'favorites') removeFavorite.run(userId, canonical);
      else { removeRecent.run(userId, canonical); removeWatches.run(userId, canonical); }
      const [sourceId, link] = JSON.parse(canonical) as [string, string];
      catalog?.removeLegacyData(userId, sourceId, link, kind);
    });
    return { ok: true };
  });
}
