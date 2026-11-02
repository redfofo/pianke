import { create } from 'zustand';

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'user';
  createdAt: number;
  sourceIds: string[];
}

interface AuthState {
  user: User | null;
  ready: boolean;
  loading: boolean;
  error: string;
}

export const useAuth = create<AuthState>()(() => ({ user: null, ready: false, loading: false, error: '' }));
const authState = () => useAuth.getState();
const setAuth = (patch: Partial<AuthState>) => useAuth.setState(patch);

class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function accountRequest<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('无法连接服务器，请检查网络后重试。');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message || payload?.message;
    if (response.status === 401 && path.startsWith('/admin/')) {
      window.location.assign(
        `/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
    }
    throw new AccountError(
      typeof message === 'string' ? message : `请求失败（${response.status}），请重试。`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

let pendingSession: Promise<void> | undefined;
let sessionLoaded = false;
export function loadSession(): Promise<void> {
  if (pendingSession) return pendingSession;
  setAuth({ loading: true, error: '' });
  pendingSession = accountRequest<{ user: User | null }>('/auth/me')
    .then(({ user }) => {
      const current = authState().user;
      if (sessionLoaded && current?.id !== user?.id) {
        window.location.replace(
          `/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`,
        );
        throw new Error('登录状态已变更，正在重新载入…');
      }
      if (
        sessionLoaded &&
        current &&
        user &&
        (current.role !== user.role ||
          current.sourceIds.length !== user.sourceIds.length ||
          current.sourceIds.some((id) => !user.sourceIds.includes(id)))
      ) {
        reloadAccountDocument();
        return;
      }
      setAuth({ user, ready: true });
      sessionLoaded = true;
    })
    .catch((reason: unknown) => {
      setAuth({ ready: false, error: reason instanceof Error ? reason.message : '无法读取登录状态，请重试。' });
      throw reason;
    })
    .finally(() => {
      setAuth({ loading: false });
      pendingSession = undefined;
    });
  return pendingSession;
}

export function safeRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) <= 32 || value[index] === '\\') return '/';
  }
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith('//') || /^\/login\/?$/i.test(url.pathname))
      return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

const sessionEventKey = 'mu-jian-session-change';
const sessionChannel =
  typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new window.BroadcastChannel(sessionEventKey)
    : undefined;
let reloading = false;
function reloadAccountDocument() {
  if (reloading) return;
  reloading = true;
  setAuth({ ready: false });
  window.location.reload();
}
if (typeof window !== 'undefined') {
  sessionChannel?.addEventListener('message', reloadAccountDocument);
  window.addEventListener('storage', (event) => {
    if (event.key === sessionEventKey) reloadAccountDocument();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) reloadAccountDocument();
  });
}
function announceSessionChange() {
  sessionChannel?.postMessage('changed');
  try {
    window.localStorage.setItem(sessionEventKey, `${Date.now()}:${Math.random()}`);
  } catch {
    // BroadcastChannel still reaches other tabs when browser storage is disabled.
  }
}

export async function login(username: string, password: string, redirect: unknown): Promise<void> {
  await accountRequest<{ user: User }>('/auth/login', { username, password });
  announceSessionChange();
  window.location.replace(safeRedirect(redirect));
}

export async function logout(): Promise<void> {
  try {
    await accountRequest<{ ok: true }>('/auth/logout', {});
  } catch (reason) {
    if (!(reason instanceof AccountError) || reason.status !== 401) throw reason;
  }
  announceSessionChange();
  window.location.replace('/login');
}

export async function listUsers(): Promise<User[]> {
  return (await accountRequest<{ users: User[] }>('/admin/users')).users;
}

export interface SourceEntry {
  id: string;
  title: string;
}

/** Every source known to the server, including ones added upstream after this build. */
export async function listSourceEntries(): Promise<SourceEntry[]> {
  return (await accountRequest<{ sources: SourceEntry[] }>('/admin/sources')).sources;
}

export async function createUser(username: string, password: string, sourceIds: string[]): Promise<User> {
  return (await accountRequest<{ user: User }>('/admin/users', { username, password, sourceIds })).user;
}

export async function saveUserSources(id: string, sourceIds: string[]): Promise<User> {
  return (await accountRequest<{ user: User }>(`/admin/users/${encodeURIComponent(id)}/sources`, { sourceIds })).user;
}
