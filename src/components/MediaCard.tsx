import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ImageOff, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { MediaItem } from '../types';
import { useIsFavorite, useLibrary } from '../stores';

type CardItem = Pick<MediaItem, 'id' | 'sourceId' | 'link' | 'title' | 'posterUrl'> &
  Partial<Pick<MediaItem, 'description' | 'remark'>>;

export function watchPath(item: Pick<MediaItem, 'sourceId' | 'link'>, episodeId?: string) {
  const query = new URLSearchParams({ link: item.link, ...(episodeId ? { episode: episodeId } : {}) });
  return `/watch/${encodeURIComponent(item.sourceId)}?${query}`;
}

/** Portrait poster with a text fallback when the image is missing or fails to load. */
export function Poster({
  url,
  title,
  className,
  children,
  hover,
}: {
  url: string;
  title: string;
  className?: string;
  children?: ReactNode;
  hover?: boolean;
}) {
  // Keyed by URL, so a new poster for the same card gets another chance to load.
  const [failedUrl, setFailedUrl] = useState('');
  const failed = !!url && failedUrl === url;
  return (
    <div
      className={cn(
        'relative aspect-[3/4] shrink-0 overflow-hidden rounded-lg bg-cover shadow-sm ring-1 ring-foreground/10',
        className,
      )}
    >
      {url && !failed ? (
        <img
          src={url}
          alt={title}
          width={320}
          height={427}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(url)}
          className={cn(
            'block size-full object-cover',
            hover && 'transition-transform duration-300 ease-out group-hover/card:scale-[1.04]',
          )}
        />
      ) : (
        <div className="cover-fallback flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-muted-foreground">
          <ImageOff className="size-6" aria-hidden="true" />
          <span className="line-clamp-3 text-sm">{title}</span>
          <small className="text-[11px]">暂无封面</small>
        </div>
      )}
      {children}
    </div>
  );
}

export function MediaCard({
  item,
  note,
  episodeId,
  children,
}: {
  item: CardItem;
  note?: string;
  episodeId?: string;
  children?: ReactNode;
}) {
  const saved = useIsFavorite(item.sourceId, item.link);
  const toggleFavorite = useLibrary((state) => state.toggleFavorite);
  return (
    <article className="media-card group/card flex min-w-0 flex-col gap-1.5">
      <Link
        to={watchPath(item, episodeId)}
        className="flex flex-col gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Poster url={item.posterUrl} title={item.title} hover>
          {item.remark && (
            <span className="absolute top-2 right-2 max-w-[calc(100%-1rem)] truncate rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
              {item.remark}
            </span>
          )}
        </Poster>
        <h3 className="truncate text-sm font-medium">{item.title}</h3>
      </Link>
      <div className="card-footer -mt-1 flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {note || item.description || '查看剧集'}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${saved ? '取消收藏' : '收藏'}${item.title}`}
          aria-pressed={saved}
          onClick={() => void toggleFavorite(item)}
          className="shrink-0 text-muted-foreground aria-pressed:text-foreground"
        >
          <Star className={cn(saved && 'fill-current')} />
        </Button>
      </div>
      {children}
    </article>
  );
}

/** Progress bar and remove button shown under history cards. */
export function RecordActions({
  progress,
  label,
  onRemove,
  removeLabel,
}: {
  progress?: number;
  label: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <>
      {progress !== undefined && <Progress value={progress} aria-label={`已观看 ${progress}%`} className="h-1" />}
      <Button
        variant="ghost"
        size="xs"
        aria-label={label}
        onClick={onRemove}
        className="self-start px-0 text-muted-foreground hover:bg-transparent"
      >
        {removeLabel}
      </Button>
    </>
  );
}
