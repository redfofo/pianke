import { Link, useMatches, useParams, useSearchParams } from 'react-router';
import { RefreshCw } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { useDefaultSourceId, useEnabledSources, useSources } from '../stores';
import { Notice } from './common';

/** Source currently shown by the browse or watch page. */
export function useSelectedSourceId(): string {
  const params = useParams();
  const [query] = useSearchParams();
  const fallback = useDefaultSourceId();
  return params.sourceId || query.get('source') || fallback;
}

const sourcePath = (id: string) => ({ pathname: '/', search: `?source=${encodeURIComponent(id)}` });

/** Source list in the sidebar. */
export function SidebarSources() {
  const sources = useSources((state) => state.sources);
  const loading = useSources((state) => state.loading);
  const error = useSources((state) => state.error);
  const load = useSources((state) => state.load);
  const enabled = useEnabledSources();
  const selected = useSelectedSourceId();
  const matches = useMatches();
  const routeId = matches[matches.length - 1]?.id;
  const inSource = routeId === 'browse' || routeId === 'watch';
  return (
    <SidebarGroup>
      <SidebarGroupLabel>内容来源</SidebarGroupLabel>
      <SidebarGroupAction title="刷新来源" aria-label="刷新来源" disabled={loading} onClick={() => void load(true)}>
        <RefreshCw className={cn(loading && 'animate-spin')} />
      </SidebarGroupAction>
      <SidebarGroupContent>
        {error && (
          <div className="px-2 pb-2 group-data-[collapsible=icon]:hidden">
            <Notice title={error} />
          </div>
        )}
        <nav aria-label="内容来源">
          <SidebarMenu>
            {loading &&
              !sources.length &&
              Array.from({ length: 4 }, (_, index) => (
                <SidebarMenuItem key={index}>
                  <SidebarMenuSkeleton showIcon />
                </SidebarMenuItem>
              ))}
            {enabled.map((source) => (
              <SidebarMenuItem key={source.id}>
                <SidebarMenuButton
                  asChild
                  size="lg"
                  tooltip={source.title}
                  isActive={source.id === selected && inSource}
                >
                  <Link
                    to={sourcePath(source.id)}
                    aria-current={source.id === selected && routeId === 'browse' ? 'page' : undefined}
                  >
                    <span
                      aria-hidden="true"
                      className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground group-data-[active=true]/menu-button:bg-primary group-data-[active=true]/menu-button:text-primary-foreground"
                    >
                      {source.title.slice(0, 1)}
                    </span>
                    <span className="grid flex-1 text-left leading-tight">
                      <span className="truncate font-medium">{source.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {source.error ? '暂不可用' : source.capabilities.includes('search') ? '浏览与搜索' : '分类浏览'}
                      </span>
                    </span>
                  </Link>
                </SidebarMenuButton>
                {source.error && (
                  <SidebarMenuBadge className="text-warning" aria-label="来源暂不可用">
                    !
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Horizontal source switcher shown above the browse page when the sidebar is hidden. */
export function SourceChips({ selected }: { selected: string }) {
  const enabled = useEnabledSources();
  if (!enabled.length) return null;
  return (
    <nav aria-label="切换来源" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:hidden">
      {enabled.map((source) => (
        <Link
          key={source.id}
          to={sourcePath(source.id)}
          aria-current={source.id === selected ? 'page' : undefined}
          className={cn(
            'inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors hover:bg-muted',
            source.id === selected && 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
            source.error && 'line-through opacity-70',
          )}
        >
          {source.title}
          {source.error && <span className="sr-only">（暂不可用）</span>}
        </Link>
      ))}
    </nav>
  );
}
