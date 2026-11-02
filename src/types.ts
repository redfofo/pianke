export type SourceCapability = 'browser' | 'search' | 'detail' | 'playback';
export interface Parameter {
  name: string;
  title: string;
  type: string;
  value?: string;
  defaultValue?: string;
  enumOptions?: { title: string; value: string }[];
}
export interface SourceModule {
  id: string;
  title: string;
  params: Parameter[];
}
export interface Source {
  id: string;
  title: string;
  description: string;
  version: string;
  capabilities: SourceCapability[];
  icon: string;
  modules: SourceModule[];
  error?: string;
}
export interface MediaItem {
  id: string;
  title: string;
  posterUrl: string;
  description?: string;
  remark?: string;
  link: string;
  mediaType?: string;
  sourceId: string;
}
export interface Episode {
  id: string;
  title: string;
  episodeNumber?: number;
  seasonNumber?: number;
  videoUrl: string;
  link: string;
  customHeaders?: Record<string, string>;
  playerType?: string;
}
export interface Season {
  seasonNumber: number;
  title?: string;
  episodes: Episode[];
}
export interface Detail extends MediaItem {
  seasons: Season[];
  episodeItems: Episode[];
}
export interface PlaybackSource {
  src: string;
  type: string;
  title: string;
}
export interface Playback {
  sources: PlaybackSource[];
}
export interface BrowseResult {
  items: MediaItem[];
  page: number;
  hasMore: boolean;
  total?: number;
  pageCount?: number;
  /** Search answered from the server's catalog because the upstream failed or was too slow. */
  local?: boolean;
}
export interface SourceHealth {
  browse?: { ok: boolean; message: string; at: number };
  search?: { ok: boolean; message: string; at: number };
  detail?: { ok: boolean; message: string; at: number };
  playback?: { ok: boolean; message: string; at: number };
}
