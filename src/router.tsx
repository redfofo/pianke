import { createBrowserRouter, redirect, type LoaderFunctionArgs, type RouteObject } from 'react-router';
import { useAuth, loadSession, safeRedirect } from './auth';
import { AppShell, SessionPending } from './components/AppShell';
import BrowseView from './views/BrowseView';

export interface RouteHandle {
  title: string;
}

async function sessionLoader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const toLogin = url.pathname === '/login';
  if (!useAuth.getState().ready || toLogin) {
    try {
      await loadSession();
    } catch {
      // AppShell presents the connection error without mounting protected views.
      return null;
    }
  }
  const user = useAuth.getState().user;
  if (!user) return toLogin ? null : redirect(`/login?${new URLSearchParams({ redirect: url.pathname + url.search })}`);
  if (toLogin) return redirect(safeRedirect(url.searchParams.get('redirect')));
  return null;
}

// Child loaders run alongside sessionLoader, so on a direct visit the session may still be loading.
async function adminOnly() {
  if (!useAuth.getState().ready) await loadSession().catch(() => undefined);
  return useAuth.getState().user?.role === 'admin' ? null : redirect('/');
}

const page = (load: () => Promise<{ default: React.ComponentType }>) => async () => ({
  Component: (await load()).default,
});

export const routes: RouteObject[] = [
  {
    id: 'root',
    path: '/',
    Component: AppShell,
    HydrateFallback: SessionPending,
    loader: sessionLoader,
    children: [
      { id: 'browse', index: true, Component: BrowseView, handle: { title: '发现' } },
      { id: 'login', path: 'login', lazy: page(() => import('./views/LoginView')), handle: { title: '登录' } },
      {
        id: 'admin-users',
        path: 'admin/users',
        loader: adminOnly,
        lazy: page(() => import('./views/AdminUsersView')),
        handle: { title: '账号管理' },
      },
      { id: 'catalog', path: 'library', lazy: page(() => import('./views/CatalogView')), handle: { title: '媒体库' } },
      {
        id: 'search',
        path: 'search',
        lazy: page(() => import('./views/SearchView')),
        handle: { title: '全部来源搜索' },
      },
      {
        id: 'watch',
        path: 'watch/:sourceId',
        lazy: page(() => import('./views/WatchView')),
        handle: { title: '播放' },
      },
      {
        id: 'history',
        path: 'history',
        lazy: page(() => import('./views/LibraryView')),
        handle: { title: '观看记录' },
      },
      {
        id: 'favorites',
        path: 'favorites',
        lazy: page(() => import('./views/LibraryView')),
        handle: { title: '我的收藏' },
      },
      { id: 'settings', path: 'settings', lazy: page(() => import('./views/SettingsView')), handle: { title: '设置' } },
      { path: '*', loader: () => redirect('/') },
    ],
  },
];

export const router = createBrowserRouter(routes);
