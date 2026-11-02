import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { search } from '../api';
import { createLimiter } from '../browse';
import { useEnabledSources, useSources } from '../stores';
import { EmptyState, LinesSkeleton, PageHeading } from '../components/common';
import { MediaCard } from '../components/MediaCard';
import { SearchForm } from '../components/SearchForm';

// At most three sources are searched at once so one query does not fan out across every upstream.
const limited = createLimiter(3);

export default function SearchView() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const loading = useSources((state) => state.loading);
  const hasSources = useSources((state) => state.sources.length > 0);
  const enabled = useEnabledSources();
  const query = (params.get('q') || '').trim();
  const searchable = enabled.filter((source) => !source.error && source.capabilities.includes('search'));
  const results = useQueries({
    queries: searchable.map((source) => ({
      queryKey: ['search', source.id, query, 1],
      queryFn: ({ signal }: { signal: AbortSignal }) => limited(() => search(source.id, query, 1, signal)),
      enabled: !!query,
    })),
  });
  const groups = searchable.map((source, index) => {
    const result = results[index];
    return {
      source,
      items: result?.data?.items || [],
      hasMore: !!result?.data?.hasMore,
      local: !!result?.data?.local,
      loading: !!result?.isLoading,
      error: result?.error instanceof Error ? result.error.message : '',
      retry: () => void result?.refetch(),
    };
  });
  const pending = groups.filter((group) => group.loading).length;
  const found = groups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <section aria-labelledby="search-title" className="flex flex-col gap-4">
      <PageHeading id="search-title" title="全部来源搜索">
        <SearchForm
          initial={query}
          label="搜索全部来源"
          busy={pending > 0}
          onSubmit={(value) => void navigate(value ? `/search?${new URLSearchParams({ q: value })}` : '/search')}
        />
      </PageHeading>
      {loading && !hasSources ? (
        <LinesSkeleton />
      ) : !query ? (
        <EmptyState description="输入剧名后开始搜索。" />
      ) : !searchable.length ? (
        <EmptyState description="当前没有可搜索的来源。">
          <Link to="/settings">检查来源状态</Link>
        </EmptyState>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {pending ? `正在搜索，剩余 ${pending} 个来源…` : `共找到 ${found} 个结果`}
          </p>
          {groups.map((group) => (
            <Card key={group.source.id} role="region" aria-labelledby={`group-${group.source.id}`}>
              <CardHeader>
                <CardTitle id={`group-${group.source.id}`} role="heading" aria-level={2}>
                  {group.source.title}
                </CardTitle>
                {!group.loading && (
                  <CardDescription>
                    {group.error ? '搜索失败' : `${group.items.length} 个结果`}
                    {group.local && ' · 来源未及时响应，以下为本地媒体库中的结果'}
                  </CardDescription>
                )}
                {group.hasMore && (
                  <CardAction>
                    <Button asChild variant="outline" size="sm">
                      <Link to={`/?${new URLSearchParams({ source: group.source.id, q: query })}`}>查看更多</Link>
                    </Button>
                  </CardAction>
                )}
              </CardHeader>
              <CardContent>
                {group.loading ? (
                  <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner />
                    搜索中…
                  </span>
                ) : group.error ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    <span>{group.error}</span>
                    <Button variant="outline" size="sm" onClick={group.retry}>
                      重试
                    </Button>
                  </div>
                ) : !group.items.length ? (
                  <p className="text-sm text-muted-foreground">没有找到相关剧目。</p>
                ) : (
                  <div className="cover-grid">
                    {group.items.map((item) => (
                      <MediaCard key={`${item.sourceId}:${item.id}:${item.link}`} item={item} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </section>
  );
}
