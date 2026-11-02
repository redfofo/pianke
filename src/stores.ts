import { useMemo } from 'react';
import { create } from 'zustand';
import {
  clearLibrary,
  getLibrary,
  getSources,
  getWatch as fetchWatch,
  removeLibraryRecord,
  saveWatch as persistWatch,
  toggleFavorite as persistFavorite,
} from './api';
import { recordKey, toRecent, type FavoriteRecord, type RecentRecord, type WatchRecord } from './storage';
import { usePreferences } from './preferences';
import type { MediaItem, Source } from './types';

interface SourcesState {
  sources: Source[];
  loading: boolean;
  loaded: boolean;
  error: string;
  load: (force?: boolean, reset?: boolean) => Promise<void>;
}

let pendingSources: Promise<void> | undefined;
let sourcesController: AbortController | undefined;

export const useSources = create<SourcesState>()((set, get) => ({
  sources: [],
  loading: false,
  loaded: false,
  error: '',
  load(force = false, reset = false) {
    if (pendingSources && !reset) return pendingSources;
    if (get().loaded && !force) return Promise.resolve();
    sourcesController?.abort();
    const current = new AbortController();
    sourcesController = current;
    if (reset) set({ sources: [], loaded: false });
    set({ loading: true, error: '' });
    pendingSources = getSources(current.signal)
      .then((sources) => {
        if (!current.signal.aborted) set({ sources, loaded: true });
      })
      .catch((reason) => {
        if (!current.signal.aborted) set({ error: reason instanceof Error ? reason.message : '无法读取来源' });
      })
      .finally(() => {
        if (!current.signal.aborted) {
          set({ loading: false });
          pendingSources = undefined;
        }
      });
    return pendingSources;
  },
}));

/** Applies the user's saved order; sources not in it keep upstream order after the ordered ones. */
export function orderSources(sources: Source[], order: string[]): Source[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return sources
    .map((source, index) => ({ source, index, rank: rank.get(source.id) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.source);
}

export function enabledSources(sources: Source[], disabled: string[], order: string[]): Source[] {
  const hidden = new Set(disabled);
  return orderSources(sources, order).filter((source) => !hidden.has(source.id));
}

/** Last visited source when still usable, otherwise the first usable one. */
export function defaultSourceId(enabled: Source[], lastSource: string): string {
  const usable = enabled.filter((source) => !source.error);
  return usable.find((source) => source.id === lastSource)?.id || usable[0]?.id || enabled[0]?.id || '';
}

/** All sources in the user's order, including hidden ones (for settings). */
export function useOrderedSources(): Source[] {
  const sources = useSources((state) => state.sources);
  const order = usePreferences((state) => state.sourceOrder);
  return useMemo(() => orderSources(sources, order), [sources, order]);
}

export function useEnabledSources(): Source[] {
  const sources = useSources((state) => state.sources);
  const disabled = usePreferences((state) => state.disabledSources);
  const order = usePreferences((state) => state.sourceOrder);
  return useMemo(() => enabledSources(sources, disabled, order), [sources, disabled, order]);
}

export function useDefaultSourceId(): string {
  const enabled = useEnabledSources();
  const lastSource = usePreferences((state) => state.lastSource);
  return defaultSourceId(enabled, lastSource);
}

type LibraryKind = 'history' | 'favorites';

interface LibraryState {
  favorites: FavoriteRecord[];
  recent: RecentRecord[];
  favoritesReady: boolean;
  recentReady: boolean;
  error: string;
  setError: (message: string) => void;
  start: (force?: boolean) => Promise<void>;
  getRecent: (key: string) => Promise<RecentRecord | undefined>;
  getWatch: (key: string, signal?: AbortSignal) => Promise<WatchRecord | null>;
  toggleFavorite: (item: MediaItem) => Promise<unknown>;
  saveWatch: (row: WatchRecord) => Promise<unknown>;
  clear: (kind: LibraryKind) => Promise<unknown>;
  remove: (kind: LibraryKind, key: string) => Promise<unknown>;
}

let libraryStarted: Promise<void> | undefined;
let libraryWrites: Promise<unknown> = Promise.resolve();

export const useLibrary = create<LibraryState>()((set, get) => {
  // Serialize loads and mutations so an older snapshot cannot overwrite a completed save.
  const enqueue = (operation: () => Promise<void>, message: string) => {
    libraryWrites = libraryWrites.then(operation).catch((reason) => {
      set({ error: `${message}：${reason instanceof Error ? reason.message : String(reason)}` });
    });
    return libraryWrites;
  };
  return {
    favorites: [],
    recent: [],
    favoritesReady: false,
    recentReady: false,
    error: '',
    setError: (error) => set({ error }),
    start(force = false) {
      if (libraryStarted && !force) return libraryStarted;
      libraryStarted = enqueue(async () => {
        try {
          const value = await getLibrary();
          set({ favorites: value.favorites, recent: value.recent, error: '' });
        } finally {
          set({ favoritesReady: true, recentReady: true });
        }
      }, '账号记录读取失败').then(() => {});
      return libraryStarted;
    },
    async getRecent(key) {
      await get().start();
      return get().recent.find((row) => row.key === key);
    },
    async getWatch(key, signal) {
      await libraryWrites;
      return fetchWatch(key, signal);
    },
    toggleFavorite(item) {
      return enqueue(async () => {
        const record: FavoriteRecord = {
          key: recordKey(item.sourceId, item.link),
          sourceId: item.sourceId,
          mediaId: item.id,
          link: item.link,
          title: item.title,
          posterUrl: item.posterUrl,
          savedAt: Date.now(),
        };
        const result = await persistFavorite(record);
        const rest = get().favorites.filter((row) => row.key !== record.key);
        set({ favorites: result.favorite ? [record, ...rest] : rest, error: '' });
      }, '收藏保存失败');
    },
    saveWatch(row) {
      return enqueue(async () => {
        const result = await persistWatch(row);
        const latest = toRecent(result.watch);
        set({ recent: [latest, ...get().recent.filter((item) => item.key !== latest.key)], error: '' });
      }, '播放进度保存失败');
    },
    clear(kind) {
      return enqueue(async () => {
        await clearLibrary(kind);
        set(kind === 'history' ? { recent: [], error: '' } : { favorites: [], error: '' });
      }, '清除失败');
    },
    remove(kind, key) {
      return enqueue(async () => {
        await removeLibraryRecord(kind, key);
        set(
          kind === 'history'
            ? { recent: get().recent.filter((row) => row.key !== key), error: '' }
            : { favorites: get().favorites.filter((row) => row.key !== key), error: '' },
        );
      }, '删除失败');
    },
  };
});

export function useIsFavorite(sourceId: string, link: string): boolean {
  const key = recordKey(sourceId, link);
  return useLibrary((state) => state.favorites.some((row) => row.key === key));
}
