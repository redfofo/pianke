import { useEffect, useState } from 'react';
import { Link, Outlet, ScrollRestoration, useLocation, useMatches } from 'react-router';
import * as m from 'motion/react-m';
import { toast } from 'sonner';
import { Clock, House, LibraryBig, LogOut, Moon, Search, Settings, Star, Sun, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { handleDirectionalNavigation } from '@/lib/directional-navigation';
import { cn } from '@/lib/utils';
import { loadSession, logout, useAuth } from '../auth';
import { isDark, usePreferences } from '../preferences';
import { useLibrary, useSources } from '../stores';
import type { RouteHandle } from '../router';
import { Notice } from './common';
import { SidebarSources } from './SourceRail';

interface NavigationItem {
  to: string;
  title: string;
  short: string;
  icon: LucideIcon;
  ids: string[];
  mobile: boolean;
}

const navigation: NavigationItem[] = [
  { to: '/', title: '首页', short: '首页', icon: House, ids: ['browse'], mobile: true },
  { to: '/library', title: '媒体库', short: '媒体库', icon: LibraryBig, ids: ['catalog'], mobile: true },
  { to: '/search', title: '搜索', short: '搜索', icon: Search, ids: ['search'], mobile: true },
  { to: '/history', title: '继续观看', short: '记录', icon: Clock, ids: ['history'], mobile: false },
  { to: '/favorites', title: '我的收藏', short: '收藏', icon: Star, ids: ['favorites'], mobile: true },
  {
    to: '/settings',
    title: '服务器设置',
    short: '设置',
    icon: Settings,
    ids: ['settings', 'admin-users'],
    mobile: true,
  },
];

// The sidebar component writes its open state to this cookie; read it back so the choice survives reloads.
const sidebarOpen = () => typeof document === 'undefined' || !/(?:^|;\s*)sidebar_state=false/.test(document.cookie);

/** Same artwork as docs/design/logo/logo.svg and the PWA icons. */
function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" className={className}>
      <rect width="512" height="512" rx="112" fill="#FF5A36" />
      <circle
        cx="256"
        cy="256"
        r="150"
        fill="none"
        stroke="#fff"
        strokeWidth="40"
        strokeLinecap="round"
        strokeDasharray="785.4 157.1"
        transform="rotate(-30 256 256)"
      />
      <circle cx="331" cy="126.1" r="20" fill="#fff" />
      <path d="M226 192 L226 320 L326 256 Z" fill="#fff" stroke="#fff" strokeWidth="24" strokeLinejoin="round" />
    </svg>
  );
}

function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <LogoMark className="size-8 shrink-0" />
      <span className="grid flex-1 text-left leading-tight">
        <span className="font-semibold">片刻</span>
        <span className="truncate text-xs text-muted-foreground">短剧放映室</span>
      </span>
    </span>
  );
}

/** Centered page for the session gate and the login form, outside the sidebar layout. */
function StandalonePage({ children }: { children: React.ReactNode }) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10 outline-none"
    >
      <Brand />
      {children}
    </main>
  );
}

/** Shown by the router while the session loader runs on first load. */
export function SessionPending() {
  return (
    <StandalonePage>
      <p role="status" className="text-sm text-muted-foreground">
        正在读取登录状态…
      </p>
    </StandalonePage>
  );
}

function ThemeToggle() {
  const theme = usePreferences((state) => state.theme);
  const setTheme = usePreferences((state) => state.setTheme);
  const dark = isDark(theme);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? '切换到浅色' : '切换到深色'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

function AppSidebar({ routeId }: { routeId: string }) {
  const user = useAuth((state) => state.user);
  const location = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  // The mobile sheet closes once a link inside it has been followed.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [location.pathname, location.search, isMobile, setOpenMobile]);

  async function signOut() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError('');
    try {
      await logout();
    } catch (reason) {
      setLogoutError(reason instanceof Error ? reason.message : '退出失败，请重试。');
      setLoggingOut(false);
    }
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="片刻首页">
              <Link to="/" aria-label="片刻首页">
                <Brand />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>导航</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="主导航">
              <SidebarMenu>
                {navigation.map((item) => {
                  const active = item.ids.includes(routeId);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                        <Link to={item.to} aria-current={active ? 'page' : undefined}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSources />
      </SidebarContent>
      <SidebarFooter>
        {logoutError && (
          <div className="group-data-[collapsible=icon]:hidden">
            <Notice title={logoutError} />
          </div>
        )}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="当前账号与设置">
              <Link to="/settings" aria-label="当前账号与设置" title={user?.username}>
                <span
                  aria-hidden="true"
                  className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold"
                >
                  {user?.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-medium">{user?.username}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user?.role === 'admin' ? '管理员' : '普通用户'}
                  </span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="退出" disabled={loggingOut} onClick={signOut}>
              <LogOut />
              <span>退出</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function AppShell() {
  const matches = useMatches();
  const location = useLocation();
  const leaf = matches[matches.length - 1];
  const routeId = leaf?.id || '';
  const title = (leaf?.handle as RouteHandle | undefined)?.title;
  const user = useAuth((state) => state.user);
  const ready = useAuth((state) => state.ready);
  const authLoading = useAuth((state) => state.loading);
  const authError = useAuth((state) => state.error);
  const libraryError = useLibrary((state) => state.error);
  const setLibraryError = useLibrary((state) => state.setError);
  const preferencesError = usePreferences((state) => state.error);
  const clearPreferencesError = usePreferences((state) => state.clearError);
  const isLogin = routeId === 'login';
  const protectedReady = ready && !!user && !isLogin;
  const hideBottomNav = !protectedReady || routeId === 'watch';

  useEffect(() => {
    document.title = `${title || '短剧'} · 片刻`;
  }, [title]);
  useEffect(() => {
    document.documentElement.classList.toggle('no-bottom-nav', hideBottomNav);
  }, [hideBottomNav]);
  useEffect(() => {
    if (!protectedReady) return;
    void useSources.getState().load();
    void useLibrary.getState().start();
  }, [protectedReady]);
  useEffect(() => {
    if (protectedReady && routeId === 'settings') void useSources.getState().load(true);
  }, [protectedReady, routeId]);
  useEffect(() => {
    if (!protectedReady) return;
    const sync = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        await loadSession();
        if (!useAuth.getState().user) return;
        void useSources.getState().load(true);
        void useLibrary.getState().start(true);
      } catch {
        // The session gate offers a retry without retaining stale account content.
      }
    };
    const timer = window.setInterval(sync, 30_000);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [protectedReady]);
  useEffect(() => {
    window.addEventListener('keydown', handleDirectionalNavigation);
    return () => window.removeEventListener('keydown', handleDirectionalNavigation);
  }, []);
  // Library failures are transient: show them as toasts instead of banners.
  useEffect(() => {
    if (!libraryError) return;
    toast.error(libraryError);
    setLibraryError('');
  }, [libraryError, setLibraryError]);
  useEffect(() => {
    if (!preferencesError) return;
    toast.error(preferencesError);
    clearPreferencesError();
  }, [preferencesError, clearPreferencesError]);

  const skipLink = (
    <a
      href="#main-content"
      className="fixed -top-20 left-4 z-[100] rounded-md bg-background px-4 py-2 text-sm shadow focus:top-3"
    >
      跳到内容
    </a>
  );

  if (!ready || (!protectedReady && !isLogin))
    return (
      <>
        {skipLink}
        <StandalonePage>
          {authError ? (
            <>
              <h1 className="text-xl font-semibold tracking-tight">暂时无法读取登录状态</h1>
              <Notice title={authError} />
              <Button disabled={authLoading} onClick={() => window.location.reload()}>
                重新连接
              </Button>
            </>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              正在读取登录状态…
            </p>
          )}
        </StandalonePage>
      </>
    );
  if (isLogin)
    return (
      <>
        {skipLink}
        <StandalonePage>
          <Outlet />
        </StandalonePage>
        <Toaster position="top-center" />
      </>
    );

  return (
    <TooltipProvider>
      {skipLink}
      <SidebarProvider defaultOpen={sidebarOpen()}>
        <AppSidebar routeId={routeId} />
        <SidebarInset id="main-content" tabIndex={-1} className="min-w-0 outline-none">
          <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
            <SidebarTrigger aria-label="切换侧栏" />
            <Separator orientation="vertical" className="h-4 data-vertical:self-center" />
            <span className="truncate text-sm font-medium">{title}</span>
            <div className="ml-auto flex items-center gap-1">
              <Link
                to="/search"
                aria-label="搜索全部来源"
                className="hidden h-8 w-64 items-center gap-2 rounded-lg border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:flex"
              >
                <Search className="size-4" />
                搜索剧名与来源
              </Link>
              <Button asChild variant="ghost" size="icon" className="lg:hidden">
                <Link to="/search" aria-label="搜索全部来源">
                  <Search />
                </Link>
              </Button>
              <ThemeToggle />
            </div>
          </header>
          <m.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="mx-auto flex w-full max-w-[1920px] min-w-0 flex-1 flex-col gap-4 p-4 pb-[calc(1rem+var(--bottom-nav-height))] md:p-6"
          >
            <Outlet />
          </m.div>
        </SidebarInset>
      </SidebarProvider>
      {!hideBottomNav && (
        // Phones keep a bottom tab bar within thumb reach; the sidebar sheet stays available from the header.
        <nav
          aria-label="主导航（底部）"
          className="fixed inset-x-0 bottom-0 z-30 grid h-(--bottom-nav-height) grid-cols-5 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
        >
          {navigation
            .filter((item) => item.mobile)
            .map((item) => {
              const active = item.ids.includes(routeId);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground',
                    active && 'font-medium text-foreground',
                  )}
                >
                  {active && (
                    <m.span
                      layoutId="bottom-nav-active"
                      className="absolute top-0 h-0.5 w-8 rounded-full bg-foreground"
                      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                    />
                  )}
                  <item.icon className="size-5" />
                  <span>{item.short}</span>
                </Link>
              );
            })}
        </nav>
      )}
      <Toaster position="top-center" />
      <ScrollRestoration />
    </TooltipProvider>
  );
}
