import type { CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import * as m from 'motion/react-m';
import { CirclePlay } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { getCatalog } from '../api';
import { useEnabledSources, useSources } from '../stores';
import { CoverSkeletonGrid, EmptyState, PageHeading, StatePanel } from '../components/common';
import { MediaCard, Poster, watchPath } from '../components/MediaCard';
import { SearchForm } from '../components/SearchForm';

// ToggleGroup treats '' as "nothing selected", so the "all sources" tab needs its own value.
const ALL = '\u0000all';

export default function CatalogView() {
  const [query] = useSearchParams();
  const navigateTo = useNavigate();
  const sources = useSources((state) => state.sources);
  const enabled = useEnabledSources();
  const sourceId = query.get('source') || '';
  const keyword = (query.get('q') || '').trim();
  const catalogQuery = useQuery({
    queryKey: ['catalog', sourceId, keyword],
    queryFn: ({ signal }) => getCatalog(sourceId, keyword, 0, 120, signal),
  });
  const items = catalogQuery.data?.items || [];
  const featured = items[0];
  const sourceName = sources.find((source) => source.id === sourceId)?.title || '全部媒体';
  const navigate = (source: string, q: string) =>
    void navigateTo(`/library?${new URLSearchParams({ ...(source ? { source } : {}), ...(q ? { q } : {}) })}`);

  return (
    <section aria-labelledby="catalog-title" className="flex flex-col gap-4">
      <PageHeading id="catalog-title" title="媒体库">
        <SearchForm
          initial={keyword}
          label="搜索媒体库"
          placeholder="搜索已收录内容"
          onSubmit={(value) => navigate(sourceId, value)}
        />
      </PageHeading>
      {featured && (
        <Card
          role="region"
          aria-label="精选内容"
          className="hero-backdrop py-0"
          style={featured.posterUrl ? ({ '--hero-art': `url("${featured.posterUrl}")` } as CSSProperties) : undefined}
        >
          <m.div
            key={featured.link}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="flex items-end gap-4 p-4 sm:items-center sm:gap-6 sm:p-6"
          >
            <Poster url={featured.posterUrl} title={featured.title} className="w-24 sm:w-32" />
            <div className="flex min-w-0 flex-col items-start gap-2">
              <Badge variant="secondary">{sourceName}</Badge>
              <h2 className="line-clamp-2 text-2xl font-semibold tracking-tight sm:text-3xl">{featured.title}</h2>
              {featured.description && (
                <p className="line-clamp-2 max-w-prose text-sm text-muted-foreground">{featured.description}</p>
              )}
              <Button asChild className="mt-1">
                <Link to={watchPath(featured)}>
                  <CirclePlay data-icon="inline-start" />
                  查看与播放
                </Link>
              </Button>
            </div>
          </m.div>
        </Card>
      )}
      <div
        role="navigation"
        aria-label="媒体库来源"
        className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"
      >
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={sourceId || ALL}
          onValueChange={(value) => value && navigate(value === ALL ? '' : value, keyword)}
          aria-label="媒体库来源"
        >
          {[{ id: ALL, title: '全部' }, ...enabled].map((source) => (
            <ToggleGroupItem key={source.id} value={source.id} className="px-3 whitespace-nowrap">
              {source.title}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium">{keyword ? `“${keyword}”的结果` : sourceName}</h2>
        {catalogQuery.data && (
          <span className="text-xs text-muted-foreground tabular-nums">{catalogQuery.data.total} 部内容</span>
        )}
      </div>
      {catalogQuery.isLoading ? (
        <CoverSkeletonGrid />
      ) : catalogQuery.error ? (
        <StatePanel message={catalogQuery.error.message}>
          <Button variant="outline" size="sm" onClick={() => void catalogQuery.refetch()}>
            重新加载
          </Button>
        </StatePanel>
      ) : !items.length ? (
        <EmptyState description="媒体库还没有内容。管理员可在设置中启动目录同步。" />
      ) : (
        <div className="cover-grid">
          {items.map((item) => (
            <MediaCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
