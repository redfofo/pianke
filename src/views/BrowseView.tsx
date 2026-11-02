import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Play, X } from 'lucide-react';
import * as m from 'motion/react-m';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { browse, search } from '../api';
import { useAuth } from '../auth';
import {
  editableFilters,
  formatPosition,
  isUnfinished,
  knownPages as resolveKnownPages,
  parsePage,
  resolveModule,
  resolveParams,
} from '../browse';
import { useInfiniteTrigger, useMediaQuery } from '../hooks';
import { usePreferences } from '../preferences';
import { useDefaultSourceId, useEnabledSources, useLibrary, useSources } from '../stores';
import type { BrowseResult, MediaItem } from '../types';
import { CoverSkeletonGrid, EmptyState, LinesSkeleton, Notice, PageHeading, StatePanel } from '../components/common';
import { MediaCard, Poster, RecordActions, watchPath } from '../components/MediaCard';
import { SearchForm } from '../components/SearchForm';
import { SourceChips } from '../components/SourceRail';

const itemKey = (item: MediaItem) => `${item.sourceId}:${item.id}:${item.link}`;
// Radix Select reserves the empty string for "no selection"; upstream options often use it for "all".
const EMPTY_OPTION = '\u0000empty';
const toOption = (value: string | undefined) => (value ? value : EMPTY_OPTION);
const fromOption = (value: string) => (value === EMPTY_OPTION ? '' : value);

export default function BrowseView() {
  const [query] = useSearchParams();
  const navigateTo = useNavigate();
  const sourcesLoaded = useSources((state) => state.loaded);
  const sourcesLoading = useSources((state) => state.loading);
  const sourcesError = useSources((state) => state.error);
  const allSources = useSources((state) => state.sources);
  const loadSources = useSources((state) => state.load);
  const enabled = useEnabledSources();
  const fallbackSource = useDefaultSourceId();
  const recent = useLibrary((state) => state.recent);
  const removeRecord = useLibrary((state) => state.remove);
  const setLastSource = usePreferences((state) => state.setLastSource);
  const isAdmin = useAuth((state) => state.user?.role === 'admin');
  const isMobile = useMediaQuery('(max-width: 639px)');

  const requestedSource = query.get('source') || '';
  const sourceId = requestedSource || fallbackSource;
  const source = enabled.find((item) => item.id === sourceId);
  const module = resolveModule(source, query.get('module'));
  const keyword = (query.get('q') || '').trim();
  const page = parsePage(query.get('page'));
  const queryString = query.toString();
  // Recomputed only when the URL changes, so the query key stays referentially stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const params = useMemo(() => resolveParams(module, query), [module, queryString]);
  const filters = editableFilters(module, params);

  useEffect(() => {
    if (source && !source.error) setLastSource(source.id);
  }, [source, setLastSource]);
  // An unknown or hidden ?source= falls back to the default source.
  useEffect(() => {
    if (!sourcesLoaded || sourcesLoading || !requestedSource || source) return;
    void navigateTo(fallbackSource ? `/?source=${encodeURIComponent(fallbackSource)}` : '/', { replace: true });
  }, [sourcesLoaded, sourcesLoading, requestedSource, source, fallbackSource, navigateTo]);

  const blocked = !source
    ? ''
    : source.error
      ? source.error
      : keyword && !source.capabilities.includes('search')
        ? '此来源不支持搜索，请清除搜索后浏览分类。'
        : '';
  const canFetch = !!source && !blocked && (!!keyword || (source.capabilities.includes('browser') && !!module));
  const listKey = keyword ? ['search', sourceId, keyword] : ['browse', sourceId, module?.id || '', params];
  const fetchPage = (pageNumber: number, signal: AbortSignal): Promise<BrowseResult> =>
    keyword ? search(sourceId, keyword, pageNumber, signal) : browse(sourceId, module!.id, params, pageNumber, signal);
  const listSignature = JSON.stringify(listKey);

  // Desktop: numbered pages, keeping the previous page visible while the next one loads.
  const paged = useQuery({
    queryKey: [...listKey, page],
    queryFn: ({ signal }) => fetchPage(page, signal),
    enabled: canFetch && !isMobile,
    placeholderData: (previous, previousQuery) =>
      JSON.stringify(previousQuery?.queryKey.slice(0, -1)) === listSignature ? previous : undefined,
  });
  // Phones: continuous scrolling.
  const infinite = useInfiniteQuery({
    queryKey: [...listKey, 'infinite'],
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    initialPageParam: 1,
    getNextPageParam: (last, _pages, lastParam) => (last.hasMore && last.items.length ? lastParam + 1 : undefined),
    enabled: canFetch && isMobile,
  });

  const items = useMemo<MediaItem[]>(() => {
    if (!isMobile) return paged.data?.items || [];
    const seen = new Set<string>();
    return (infinite.data?.pages || [])
      .flatMap((result) => result.items)
      .filter((item) => !seen.has(itemKey(item)) && !!seen.add(itemKey(item)));
  }, [isMobile, paged.data, infinite.data]);
  const loading = isMobile ? infinite.isLoading : paged.isLoading;
  const fetchError = isMobile ? infinite.error : paged.error;
  const error = blocked || fetchError?.message || '';
  const current = paged.data;
  const answeredLocally = isMobile ? !!infinite.data?.pages.some((result) => result.local) : !!current?.local;
  const knownPages = resolveKnownPages(page, current?.pageCount, current?.total);
  const sentinel = useInfiniteTrigger(() => {
    if (infinite.hasNextPage && !infinite.isFetchingNextPage && !infinite.error) void infinite.fetchNextPage();
  });

  const continueWatching = useMemo(
    () =>
      recent
        .filter((row) => enabled.some((item) => item.id === row.sourceId) && isUnfinished(row.position, row.duration))
        .slice(0, 8),
    [recent, enabled],
  );
  const showContinue = !keyword && page === 1 && continueWatching.length > 0;
  const spotlight = (() => {
    const latest = continueWatching[0];
    if (latest)
      return {
        item: {
          id: latest.mediaId,
          sourceId: latest.sourceId,
          link: latest.link,
          title: latest.title,
          posterUrl: latest.posterUrl,
        },
        episodeId: latest.episodeId,
        note: `继续观看 ${latest.episodeTitle}，已看到 ${formatPosition(latest.position)}`,
      };
    const first = items[0];
    return first
      ? { item: first, episodeId: undefined, note: first.description || first.remark || '打开详情查看剧集' }
      : undefined;
  })();

  function navigate(change: Record<string, string | undefined>) {
    const next = new URLSearchParams(query);
    next.set('source', sourceId);
    next.delete('page');
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    }
    void navigateTo(`/?${next}`);
  }
  const [jumpDraft, setJumpDraft] = useState('');
  function jump() {
    const value = Math.floor(Number(jumpDraft));
    setJumpDraft('');
    if (knownPages && value >= 1 && value <= knownPages && value !== page) navigate({ page: String(value) });
  }

  const posterStyle = (url: string) => (url ? ({ '--hero-art': `url("${url}")` } as CSSProperties) : undefined);

  return (
    <section aria-labelledby="browse-title" className="flex flex-col gap-4">
      <SourceChips selected={sourceId} />
      {spotlight && !keyword && page === 1 && (
        <Card
          role="region"
          aria-label="精选内容"
          className="hero-backdrop py-0"
          style={posterStyle(spotlight.item.posterUrl)}
        >
          <m.div
            key={spotlight.item.link}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="flex items-end gap-4 p-4 sm:items-center sm:gap-6 sm:p-6"
          >
            <Poster url={spotlight.item.posterUrl} title={spotlight.item.title} className="w-24 sm:w-32" />
            <div className="flex min-w-0 flex-col items-start gap-2">
              <Badge variant="secondary">{source?.title || '片刻精选'}</Badge>
              <h2 className="line-clamp-2 text-2xl font-semibold tracking-tight sm:text-3xl">{spotlight.item.title}</h2>
              <p className="line-clamp-2 text-sm text-muted-foreground">{spotlight.note}</p>
              <Button asChild className="mt-1">
                <Link to={watchPath(spotlight.item, spotlight.episodeId)}>
                  <Play data-icon="inline-start" />
                  查看详情
                </Link>
              </Button>
            </div>
          </m.div>
        </Card>
      )}
      <PageHeading
        id="browse-title"
        title={source?.title || '发现短剧'}
        description={keyword ? `搜索“${keyword}”` : undefined}
      >
        {source?.capabilities.includes('search') && (
          <SearchForm
            initial={keyword}
            label="搜索当前来源"
            busy={loading && !!keyword}
            onSubmit={(value) => navigate({ q: value || undefined })}
          />
        )}
      </PageHeading>
      {sourcesError && !source && (
        <Notice title={sourcesError}>
          <Button variant="outline" size="sm" onClick={() => void loadSources(true)}>
            重新加载来源
          </Button>
          <Link to="/settings" className="underline underline-offset-4">
            前往设置配置上游服务
          </Link>
        </Notice>
      )}
      {sourcesLoading && !source ? (
        <LinesSkeleton />
      ) : (
        !source &&
        !sourcesError && (
          <EmptyState
            description={
              !allSources.length && !isAdmin
                ? '暂无可用来源，请联系管理员。'
                : '暂无可显示的来源，请在设置中开启来源或检查上游配置。'
            }
          >
            <Link to="/settings">前往设置</Link>
          </EmptyState>
        )
      )}

      {showContinue && (
        <Card role="region" aria-labelledby="continue-title" size="sm">
          <CardHeader>
            <CardTitle id="continue-title">继续观看</CardTitle>
            <CardAction>
              <Button asChild variant="link" size="sm" className="-my-2 h-auto px-0 py-2">
                <Link to="/history">全部记录</Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="-mx-3 grid auto-cols-[112px] grid-flow-col gap-3 overflow-x-auto px-3 pb-1 [scrollbar-width:thin] sm:auto-cols-[128px]">
              {continueWatching.map((row) => (
                <MediaCard
                  key={row.key}
                  item={{
                    id: row.mediaId,
                    sourceId: row.sourceId,
                    link: row.link,
                    title: row.title,
                    posterUrl: row.posterUrl,
                  }}
                  episodeId={row.episodeId}
                  note={`${row.episodeTitle} · ${formatPosition(row.position)}`}
                >
                  <RecordActions
                    progress={
                      row.duration > 0 ? Math.min(100, Math.round((row.position / row.duration) * 100)) : undefined
                    }
                    label={`移除${row.title}的观看记录`}
                    removeLabel="移除记录"
                    onRemove={() => void removeRecord('history', row.key)}
                  />
                </MediaCard>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {source && (
        <>
          {source.modules.length > 0 && !keyword && (
            <div
              role="group"
              aria-label="内容分类"
              className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0"
            >
              {source.modules.map((entry) => (
                <Button
                  key={entry.id}
                  variant={module?.id === entry.id ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={module?.id === entry.id}
                  className="shrink-0"
                  onClick={() => void navigateTo(`/?${new URLSearchParams({ source: sourceId, module: entry.id })}`)}
                >
                  {entry.title}
                </Button>
              ))}
            </div>
          )}
          {filters.length > 0 && !keyword && (
            <FilterForm
              key={`${sourceId}:${module?.id}:${queryString}`}
              filters={filters}
              params={params}
              onApply={(values) =>
                navigate(Object.fromEntries(Object.entries(values).map(([key, value]) => [`p_${key}`, value])))
              }
            />
          )}
          {keyword && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              <span>仅搜索 {source.title}</span>
              {answeredLocally && <Badge variant="outline">来源未及时响应，显示本地媒体库中的结果</Badge>}
              <Link
                to={`/search?${new URLSearchParams({ q: keyword })}`}
                className="text-foreground underline underline-offset-4"
              >
                在全部来源中搜索
              </Link>
              <Button variant="ghost" size="sm" onClick={() => navigate({ q: undefined })}>
                <X data-icon="inline-start" />
                清除搜索
              </Button>
            </div>
          )}
          {error ? (
            <StatePanel message={error}>
              {!blocked && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void (isMobile ? infinite.refetch() : paged.refetch())}
                >
                  重新加载
                </Button>
              )}
              <Link to="/settings">检查来源状态</Link>
            </StatePanel>
          ) : loading ? (
            <CoverSkeletonGrid />
          ) : !items.length ? (
            <EmptyState
              description={keyword ? '没有找到相关剧目，换个关键词试试。' : '此分类暂无内容，可以切换分类或来源。'}
            />
          ) : (
            <div className={cn('cover-grid transition-opacity duration-150', paged.isPlaceholderData && 'opacity-50')}>
              {items.map((item) => (
                <MediaCard key={itemKey(item)} item={item} />
              ))}
            </div>
          )}

          {isMobile
            ? !error &&
              items.length > 0 && (
                <div ref={sentinel} className="load-more flex justify-center py-2" aria-live="polite">
                  {infinite.hasNextPage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={infinite.isFetchingNextPage}
                      onClick={() => void infinite.fetchNextPage()}
                    >
                      {infinite.isFetchingNextPage ? (
                        <>
                          <Spinner />
                          正在加载…
                        </>
                      ) : (
                        '加载更多'
                      )}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">已经到底了</span>
                  )}
                </div>
              )
            : !error &&
              (items.length > 0 || page > 1) && (
                <nav aria-label="分页" className="flex items-center justify-center gap-3 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1 || paged.isFetching}
                    onClick={() => navigate({ page: String(page - 1) })}
                  >
                    <ChevronLeft data-icon="inline-start" />
                    上一页
                  </Button>
                  <span aria-live="polite" className="text-sm text-muted-foreground tabular-nums">
                    {current?.total !== undefined && <>共 {current.total} 部 · </>}第 {page}
                    {knownPages && <> / {knownPages}</>} 页
                  </span>
                  {!!knownPages && knownPages > 2 && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        jump();
                      }}
                    >
                      <Input
                        inputMode="numeric"
                        aria-label="跳转页码"
                        placeholder={String(page)}
                        value={jumpDraft}
                        disabled={paged.isFetching}
                        onChange={(event) => setJumpDraft(event.target.value.replace(/\D/g, ''))}
                        onBlur={jump}
                        className="h-7 w-16 text-center"
                      />
                    </form>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!current?.hasMore || paged.isFetching}
                    onClick={() => navigate({ page: String(page + 1) })}
                  >
                    下一页
                    <ChevronRight data-icon="inline-end" />
                  </Button>
                </nav>
              )}
        </>
      )}
    </section>
  );
}

/** Module parameters; enumerations apply at once, free-text fields on change (Enter or blur). */
function FilterForm({
  filters,
  params,
  onApply,
}: {
  filters: ReturnType<typeof editableFilters>;
  params: Record<string, string>;
  onApply: (values: Record<string, string>) => void;
}) {
  const [drafts, setDrafts] = useState(params);
  const apply = (values = drafts) => {
    if (JSON.stringify(values) !== JSON.stringify(params)) onApply(values);
  };
  return (
    <form
      className="flex flex-wrap gap-3 rounded-xl border bg-card p-3 sm:gap-x-5"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      {filters.map((param) => (
        <div
          key={param.name}
          className="flex min-w-[130px] flex-[1_1_calc(50%-12px)] flex-col items-start gap-1.5 sm:min-w-0 sm:flex-none sm:flex-row sm:items-center sm:gap-2"
        >
          <label htmlFor={`filter-${param.name}`} className="text-sm whitespace-nowrap text-muted-foreground">
            {param.title}
          </label>
          {param.enumOptions?.length ? (
            <Select
              value={toOption(drafts[param.name])}
              onValueChange={(value) => {
                const next = { ...drafts, [param.name]: fromOption(value) };
                setDrafts(next);
                apply(next);
              }}
            >
              <SelectTrigger id={`filter-${param.name}`} aria-label={param.title} className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {param.enumOptions.map((option) => (
                  <SelectItem key={option.value} value={toOption(option.value)}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id={`filter-${param.name}`}
              type={param.type === 'number' ? 'number' : 'text'}
              aria-label={param.title}
              value={drafts[param.name] ?? ''}
              onChange={(event) => setDrafts({ ...drafts, [param.name]: event.target.value })}
              onBlur={() => apply()}
              className="w-full sm:w-36"
            />
          )}
        </div>
      ))}
    </form>
  );
}
