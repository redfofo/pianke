import { useEffect } from 'react';
import { Link, useMatches } from 'react-router';
import { Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { formatPosition } from '../browse';
import { useLibrary, useSources } from '../stores';
import { EmptyState, LinesSkeleton, PageHeading } from '../components/common';
import { MediaCard, RecordActions } from '../components/MediaCard';

export default function LibraryView() {
  const matches = useMatches();
  const kind = matches[matches.length - 1]?.id === 'history' ? 'history' : 'favorites';
  const history = kind === 'history';
  const library = useLibrary();
  const sources = useSources((state) => state.sources);
  useEffect(() => {
    void useLibrary.getState().start(true);
  }, [kind]);
  const ready = history ? library.recentReady : library.favoritesReady;
  const rows = history
    ? library.recent.map((row) => ({
        key: row.key,
        item: { id: row.mediaId, sourceId: row.sourceId, link: row.link, title: row.title, posterUrl: row.posterUrl },
        episodeId: row.episodeId as string | undefined,
        note: `${row.episodeTitle} · ${formatPosition(row.position)}`,
        progress: row.duration > 0 ? Math.min(100, Math.round((row.position / row.duration) * 100)) : undefined,
      }))
    : library.favorites.map((row) => ({
        key: row.key,
        item: { id: row.mediaId, sourceId: row.sourceId, link: row.link, title: row.title, posterUrl: row.posterUrl },
        episodeId: undefined,
        note: sources.find((source) => source.id === row.sourceId)?.title || row.sourceId,
        progress: undefined as number | undefined,
      }));
  const noun = history ? '记录' : '收藏';

  return (
    <section aria-labelledby="library-title" className="flex flex-col gap-4">
      <PageHeading id="library-title" title={history ? '观看记录' : '我的收藏'}>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" disabled={!rows.length}>
              <Trash2 data-icon="inline-start" />
              清空{noun}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认清空</AlertDialogTitle>
              <AlertDialogDescription>
                {history
                  ? '清空当前可访问来源的观看记录及剧集进度？此操作无法撤销，收藏不会受影响。'
                  : '清空当前可访问来源的收藏？此操作无法撤销，观看记录不会受影响。'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>保留{noun}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void library.clear(kind)}>
                确认清空
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PageHeading>
      {library.error && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => void library.start(true)}>
          重新读取账号记录
        </Button>
      )}
      {!ready ? (
        <LinesSkeleton />
      ) : !rows.length ? (
        <EmptyState
          description={history ? '还没有观看记录，打开一部剧开始播放吧。' : '还没有收藏，点击剧目旁的星标即可收藏。'}
        >
          <Button asChild>
            <Link to="/">去发现短剧</Link>
          </Button>
        </EmptyState>
      ) : (
        <div className="cover-grid">
          {rows.map((row) => (
            <MediaCard key={row.key} item={row.item} note={row.note} episodeId={row.episodeId}>
              <RecordActions
                progress={row.progress}
                label={`移除${row.item.title}的${history ? '观看记录' : '收藏'}`}
                removeLabel={`移除${noun}`}
                onRemove={() => void library.remove(kind, row.key)}
              />
            </MediaCard>
          ))}
        </div>
      )}
    </section>
  );
}
