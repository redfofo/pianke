export interface FavoriteRecord {
  key: string;
  sourceId: string;
  mediaId: string;
  link: string;
  title: string;
  posterUrl: string;
  savedAt: number;
}
/** Per-episode progress; keyed by episodeKey(). */
export interface WatchRecord {
  key: string;
  mediaKey: string;
  sourceId: string;
  mediaId: string;
  link: string;
  title: string;
  posterUrl: string;
  episodeId: string;
  episodeTitle: string;
  position: number;
  duration: number;
  updatedAt: number;
}
/** Latest watched episode per drama; keyed by recordKey(). Small and bounded by the number of dramas. */
export type RecentRecord = Omit<WatchRecord, 'mediaKey'>;

export function toRecent(row: WatchRecord): RecentRecord {
  const { mediaKey, ...rest } = row;
  return { ...rest, key: mediaKey };
}

export const recordKey = (sourceId: string, link: string) => JSON.stringify([sourceId, link]);
export const episodeKey = (sourceId: string, link: string, episodeId: string) =>
  JSON.stringify([sourceId, link, episodeId]);
