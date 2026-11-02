import type { BrowseResult, Detail, MediaItem, Playback, Source, SourceHealth } from './types';
import { useAuth } from './auth';
import type { FavoriteRecord, RecentRecord, WatchRecord } from './storage';

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (path.startsWith('/api/library')) headers.set('X-Account-Id', useAuth.getState().user?.id || '');
  const response = await fetch(path, { ...init, headers, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || (response.status === 409 && path.startsWith('/api/library'))) {
      window.location.replace(`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`);
    }
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data as T;
};
const sourcePath = (id: string) => `/api/sources/${encodeURIComponent(id)}`;
export interface UpstreamConfig {
  backendUrl: string;
  persisted: boolean;
  /** The saved catalog is still being moved over to this backend in the background. */
  migrating?: boolean;
}
export const getConfig = (signal?: AbortSignal) => request<UpstreamConfig>('/api/config', { signal });
export const saveConfig = (backendUrl: string) =>
  request<UpstreamConfig>('/api/config', { method: 'POST', body: JSON.stringify({ backendUrl }) });
export const getSources = (signal?: AbortSignal) => request<Source[]>('/api/sources', { signal });
export const getCatalog = (sourceId = '', q = '', start = 0, limit = 60, signal?: AbortSignal) =>
  request<{ items: MediaItem[]; total: number }>(
    `/api/catalog?${new URLSearchParams({
      ...(sourceId ? { sourceId } : {}),
      ...(q ? { q } : {}),
      start: String(start),
      limit: String(limit),
    })}`,
    { signal },
  );
export interface CatalogSyncStatus {
  sourceId: string;
  state: 'idle' | 'scanning' | 'error';
  scannedItems: number;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  error: string;
}
export const getCatalogStatus = (signal?: AbortSignal) =>
  request<{ serverId: string; sources: CatalogSyncStatus[] }>('/api/admin/catalog/status', { signal });
export const startCatalogSync = (sourceId?: string) =>
  request<{ accepted: true }>('/api/admin/catalog/sync', {
    method: 'POST',
    body: JSON.stringify(sourceId ? { sourceId } : {}),
  });
export const getEmbyStatus = (signal?: AbortSignal) =>
  request<{
    sessions: Record<string, unknown>[];
    transcodes: Record<string, unknown>[];
    tokens: Record<string, unknown>[];
  }>('/api/admin/emby/status', { signal });
export const browse = (
  id: string,
  module: string,
  params: Record<string, string>,
  page: number,
  signal?: AbortSignal,
) =>
  request<BrowseResult>(`${sourcePath(id)}/browse?${new URLSearchParams({ ...params, module, page: String(page) })}`, {
    signal,
  });
export const search = (id: string, q: string, page: number, signal?: AbortSignal) =>
  request<BrowseResult>(`${sourcePath(id)}/search?${new URLSearchParams({ q, page: String(page) })}`, { signal });
export const detail = (id: string, link: string, signal?: AbortSignal) =>
  request<Detail>(`${sourcePath(id)}/detail?${new URLSearchParams({ link })}`, { signal });
export const playback = (
  id: string,
  link: string,
  episodeId: string,
  serverProxy: boolean,
  refresh: boolean,
  signal?: AbortSignal,
) =>
  request<Playback>(`${sourcePath(id)}/playback`, {
    method: 'POST',
    body: JSON.stringify({ link, episodeId, serverProxy, refresh }),
    signal,
  });
export const getStatus = (signal?: AbortSignal) =>
  request<{ backendUrl: string; sources: Record<string, SourceHealth> }>('/api/status', { signal });
export const checkSource = (id: string, signal?: AbortSignal) =>
  request<SourceHealth>(`${sourcePath(id)}/check`, { method: 'POST', signal });
export const reportPlayback = (id: string, ok: boolean, message: string) =>
  request<{ ok: true }>(`${sourcePath(id)}/playback-report`, {
    method: 'POST',
    body: JSON.stringify({ ok, message }),
  });

export const getLibrary = () => request<{ favorites: FavoriteRecord[]; recent: RecentRecord[] }>('/api/library');
export const getWatch = (key: string, signal?: AbortSignal) =>
  request<{ watch: WatchRecord | null }>(`/api/library/watch?${new URLSearchParams({ key })}`, { signal }).then(
    (result) => result.watch,
  );
export const saveWatch = (record: WatchRecord) =>
  request<{ watch: WatchRecord }>('/api/library/watch', {
    method: 'POST',
    body: JSON.stringify(record),
    keepalive: true,
  });
export const toggleFavorite = (record: FavoriteRecord) =>
  request<{ favorite: boolean }>('/api/library/favorite', { method: 'POST', body: JSON.stringify({ record }) });
export const clearLibrary = (kind: 'history' | 'favorites') =>
  request<{ ok: true }>('/api/library/clear', { method: 'POST', body: JSON.stringify({ kind }) });
export const removeLibraryRecord = (kind: 'history' | 'favorites', key: string) =>
  request<{ ok: true }>('/api/library/remove', { method: 'POST', body: JSON.stringify({ kind, key }) });
