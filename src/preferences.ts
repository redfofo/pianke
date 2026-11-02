import { create } from 'zustand';

export type ThemeMode = 'system' | 'light' | 'dark';

export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Browser storage may be disabled.
  }
}
function writeSetting(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(readSetting(key) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

interface PreferencesState {
  error: string;
  autoplay: boolean;
  serverProxy: boolean;
  theme: ThemeMode;
  lastSource: string;
  disabledSources: string[];
  /** Source ids in the user's chosen order; sources missing from the list keep upstream order after them. */
  sourceOrder: string[];
  /** Width / height of the last played video, so the next episode's placeholder does not jump. */
  videoRatio: number;
  clearError: () => void;
  setAutoplay: (value: boolean) => void;
  setServerProxy: (value: boolean) => void;
  setTheme: (value: ThemeMode) => void;
  setLastSource: (id: string) => void;
  setSourceEnabled: (id: string, enabled: boolean) => void;
  setSourceOrder: (ids: string[]) => void;
  setVideoRatio: (value: number) => void;
}

function initialTheme(): ThemeMode {
  const stored = readSetting('mujian-theme');
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** Per-browser preferences, persisted in localStorage under the keys the app has always used. */
export const usePreferences = create<PreferencesState>()((set, get) => {
  const persist = (key: string, value: string) => {
    if (!writeSetting(key, value)) set({ error: '浏览器禁止保存设置，本次会话仍可使用。' });
  };
  return {
    error: '',
    autoplay: readSetting('mujian-autoplay') !== 'false',
    serverProxy: readSetting('mujian-server-proxy') !== 'false',
    theme: initialTheme(),
    lastSource: readSetting('mujian-last-source') || '',
    disabledSources: readIds('mujian-disabled-sources'),
    sourceOrder: readIds('mujian-source-order'),
    videoRatio: Number(readSetting('mujian-video-ratio')) || 0,
    clearError: () => set({ error: '' }),
    setAutoplay(value) {
      set({ autoplay: value });
      persist('mujian-autoplay', String(value));
    },
    setServerProxy(value) {
      set({ serverProxy: value });
      persist('mujian-server-proxy', String(value));
    },
    setTheme(value) {
      set({ theme: value });
      persist('mujian-theme', value);
    },
    setLastSource(id) {
      if (id === get().lastSource) return;
      set({ lastSource: id });
      writeSetting('mujian-last-source', id);
    },
    setSourceEnabled(id, enabled) {
      const disabled = get().disabledSources;
      if (!disabled.includes(id) === enabled) return;
      const next = enabled ? disabled.filter((value) => value !== id) : [...disabled, id];
      set({ disabledSources: next });
      persist('mujian-disabled-sources', JSON.stringify(next));
    },
    setSourceOrder(ids) {
      set({ sourceOrder: ids });
      persist('mujian-source-order', JSON.stringify(ids));
    },
    setVideoRatio(value) {
      if (!Number.isFinite(value) || value <= 0) return;
      set({ videoRatio: value });
      writeSetting('mujian-video-ratio', String(value));
    },
  };
});

const systemDarkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;

export function isDark(theme: ThemeMode, systemDark = !!systemDarkQuery?.matches): boolean {
  return theme === 'dark' || (theme === 'system' && systemDark);
}

/** Keeps the `dark` class and browser chrome colour in sync with the preference and the OS setting. */
export function syncTheme() {
  if (typeof document === 'undefined') return () => {};
  const apply = () => {
    const dark = isDark(usePreferences.getState().theme);
    document.documentElement.classList.toggle('dark', dark);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0a0a' : '#ffffff');
  };
  apply();
  const unsubscribe = usePreferences.subscribe((state, previous) => {
    if (state.theme !== previous.theme) apply();
  });
  systemDarkQuery?.addEventListener('change', apply);
  return () => {
    unsubscribe();
    systemDarkQuery?.removeEventListener('change', apply);
  };
}
