import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, SkipBack, SkipForward, Star } from 'lucide-react';
import { useDefaultLayout, type LayoutStorage } from 'react-resizable-panels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { detail as getDetail, playback } from '../api';
import { useAuth } from '../auth';
import { formatPosition } from '../browse';
import { useMediaQuery } from '../hooks';
import { readSetting, usePreferences } from '../preferences';
import { episodeKey, recordKey, type WatchRecord } from '../storage';
import { useIsFavorite, useLibrary, useSources } from '../stores';
import type { Detail, Episode, PlaybackSource, Season } from '../types';
import { EmptyState, LinesSkeleton, LoadingRing, StatePanel } from '../components/common';
import { VideoPlayer } from '../components/VideoPlayer';

interface PlaySession {
  id: number;
  sources: PlaybackSource[];
  record: WatchRecord;
  autoplay: boolean;
}

// The library wants a Storage-like object; this one tolerates browsers with storage disabled.
const layoutStorage: LayoutStorage = {
  getItem: readSetting,
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* The layout simply resets next time. */
    }
  },
};

function groupSeasons(media: Detail | undefined): Season[] {
  const groups = media?.seasons || [];
  if (!groups.length) return [{ seasonNumber: 1, title: '全部剧集', episodes: media?.episodeItems || [] }];
  const grouped = new Set(groups.flatMap((season) => season.episodes.map((episode) => episode.id)));
  const ungrouped = (media?.episodeItems || []).filter((episode) => !grouped.has(episode.id));
  return ungrouped.length ? [...groups, { seasonNumber: 0, title: '其他剧集', episodes: ungrouped }] : groups;
}

export default function WatchView() {
  const params = useParams();
  const [query, setQuery] = useSearchParams();
  const sourceId = params.sourceId || '';
  const link = query.get('link') || '';
  const requestedEpisode = query.get('episode') || '';
  const user = useAuth((state) => state.user);
  const source = useSources((state) => state.sources.find((item) => item.id === sourceId));
  const autoplayNext = usePreferences((state) => state.autoplay);
  const setAutoplay = usePreferences((state) => state.setAutoplay);
  const serverProxy = usePreferences((state) => state.serverProxy);
  const videoRatio = usePreferences((state) => state.videoRatio);
  const toggleFavorite = useLibrary((state) => state.toggleFavorite);
  const wide = useMediaQuery('(min-width: 1280px)');
  const permitted = user?.role === 'admin' || !!user?.sourceIds.includes(sourceId);

  // Cached for a few minutes, so leaving and re-opening a drama does not re-run slow upstream parsing.
  const detailQuery = useQuery({
    queryKey: ['detail', sourceId, link],
    queryFn: ({ signal }) => getDetail(sourceId, link, signal),
    enabled: !!link && permitted,
  });
  const media = useMemo<Detail | undefined>(
    () => (permitted && detailQuery.data ? { ...detailQuery.data, sourceId } : undefined),
    [permitted, detailQuery.data, sourceId],
  );
  const error = !permitted
    ? '无权访问此来源，请联系管理员。'
    : !link
      ? '缺少剧目链接，请返回列表重新打开。'
      : detailQuery.error?.message || '';
  const seasons = useMemo(() => groupSeasons(media), [media]);
  const episodes = useMemo(() => {
    const seen = new Set<string>();
    return [...seasons.flatMap((season) => season.episodes), ...(media?.episodeItems || [])].filter(
      (episode) => !seen.has(episode.id) && !!seen.add(episode.id),
    );
  }, [seasons, media]);
  const supportsPlayback = !source || source.capabilities.includes('playback');
  const saved = useIsFavorite(sourceId, media?.link || '');

  const [selectedId, setSelectedId] = useState('');
  const [seasonIndex, setSeasonIndex] = useState(0);
  const [session, setSession] = useState<PlaySession>();
  const [resolving, setResolving] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  // Async work reads these instead of possibly stale render values.
  const selectedRef = useRef('');
  const controllerRef = useRef<AbortController>(undefined);
  const sessionCounter = useRef(0);
  const initializedFor = useRef('');
  const latest = useRef({ media, seasons, episodes, supportsPlayback, serverProxy });
  useEffect(() => {
    latest.current = { media, seasons, episodes, supportsPlayback, serverProxy };
  });

  const selectedIndex = episodes.findIndex((episode) => episode.id === selectedId);
  const selected = episodes[selectedIndex];
  const previousEpisode = selectedIndex > 0 ? episodes[selectedIndex - 1] : undefined;
  const nextEpisode = selectedIndex >= 0 ? episodes[selectedIndex + 1] : undefined;

  const loadEpisode = useCallback(async (episode: Episode, autoplay: boolean, refresh = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    selectedRef.current = episode.id;
    setSelectedId(episode.id);
    setPlaybackError('');
    const {
      media: currentMedia,
      seasons: currentSeasons,
      supportsPlayback: canPlay,
      serverProxy: proxy,
    } = latest.current;
    if (!currentMedia || !canPlay) return;
    const matchingSeason = currentSeasons.findIndex((season) => season.episodes.some((item) => item.id === episode.id));
    if (matchingSeason >= 0) setSeasonIndex(matchingSeason);
    setResolving(true);
    try {
      const key = episodeKey(currentMedia.sourceId, currentMedia.link, episode.id);
      const library = useLibrary.getState();
      const [result, savedProgress] = await Promise.all([
        playback(currentMedia.sourceId, currentMedia.link, episode.id, proxy, refresh, controller.signal),
        library.getWatch(key, controller.signal).catch((reason) => {
          library.setError(`无法读取观看进度：${String(reason)}`);
          return undefined;
        }),
      ]);
      if (controller.signal.aborted) return;
      if (!result.sources.length) throw new Error('此来源没有返回可播放的视频，请尝试其他剧集或来源。');
      const position =
        savedProgress && savedProgress.position < savedProgress.duration - 2 ? savedProgress.position : 0;
      setSession({
        id: ++sessionCounter.current,
        sources: result.sources,
        autoplay,
        record: {
          key,
          mediaKey: recordKey(currentMedia.sourceId, currentMedia.link),
          sourceId: currentMedia.sourceId,
          mediaId: currentMedia.id,
          link: currentMedia.link,
          title: currentMedia.title,
          posterUrl: currentMedia.posterUrl,
          episodeId: episode.id,
          episodeTitle: episode.title,
          position,
          duration: savedProgress?.duration || 0,
          updatedAt: Date.now(),
        },
      });
    } catch (reason) {
      if (!controller.signal.aborted) {
        setSession(undefined);
        setPlaybackError(reason instanceof Error ? reason.message : '播放地址解析失败');
      }
    } finally {
      if (!controller.signal.aborted) setResolving(false);
    }
  }, []);

  function chooseEpisode(episode: Episode, autoplay = true) {
    // Choosing the current episode again re-resolves it so expired media links can be renewed.
    const refresh = episode.id === selectedRef.current;
    void loadEpisode(episode, autoplay, refresh);
    setQuery(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('episode', episode.id);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }
  const goTo = (episode: Episode | undefined) => {
    if (episode && supportsPlayback) chooseEpisode(episode, true);
  };

  // Pick the starting episode once per drama: the requested one, else the last watched, else the first.
  useEffect(() => {
    const target = JSON.stringify([sourceId, link]);
    if (target !== initializedFor.current) {
      initializedFor.current = target;
      controllerRef.current?.abort();
      selectedRef.current = '';
      setSession(undefined);
      setSelectedId('');
      setSeasonIndex(0);
      setPlaybackError('');
      setResolving(false);
    }
    if (!media || selectedRef.current) return;
    const library = useLibrary.getState();
    void library
      .getRecent(recordKey(sourceId, media.link))
      .catch((reason) => {
        library.setError(`无法读取观看记录：${String(reason)}`);
        return undefined;
      })
      .then((recent) => {
        if (target !== initializedFor.current || selectedRef.current) return;
        const wanted = requestedEpisode || recent?.episodeId || '';
        const { episodes: list } = latest.current;
        const episode = list.find((item) => item.id === wanted) || list[0];
        if (episode) void loadEpisode(episode, false);
      });
    // The requested episode is only read on first load; later changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, link, media, loadEpisode]);
  // Back/forward between episodes of the same drama.
  useEffect(() => {
    if (!requestedEpisode || requestedEpisode === selectedRef.current) return;
    const episode = latest.current.episodes.find((item) => item.id === requestedEpisode);
    if (episode) void loadEpisode(episode, false);
  }, [requestedEpisode, loadEpisode]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function onToggleFavorite() {
    if (!media || favoriteBusy) return;
    setFavoriteBusy(true);
    await toggleFavorite(media);
    setFavoriteBusy(false);
  }
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'mujian-watch-layout',
    panelIds: wide ? ['player', 'episodes'] : ['player'],
    storage: layoutStorage,
  });

  const backLink = (
    <Link
      to={{ pathname: '/', search: `?source=${encodeURIComponent(sourceId)}` }}
      className="-my-2 inline-flex items-center gap-1.5 self-start py-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      返回 {source?.title || '剧目列表'}
    </Link>
  );
  if (detailQuery.isLoading)
    return (
      <section aria-labelledby="watch-title" className="flex flex-col gap-4">
        {backLink}
        <div aria-busy="true">
          <p className="text-sm text-muted-foreground" role="status">
            正在读取剧集详情，部分来源需要较长时间解析。可随时返回列表取消。
          </p>
          <LinesSkeleton rows={8} />
        </div>
      </section>
    );
  if (error || !media)
    return (
      <section aria-labelledby="watch-title" className="flex flex-col gap-4">
        {backLink}
        {error && (
          <StatePanel message={error}>
            {link && (
              <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
                重新加载详情
              </Button>
            )}
          </StatePanel>
        )}
      </section>
    );

  const placeholderStyle = videoRatio ? ({ '--video-ratio': String(videoRatio) } as CSSProperties) : undefined;
  const playColumn = (
    <div className="flex min-w-0 flex-col gap-4">
      {session ? (
        <VideoPlayer
          sources={session.sources}
          record={session.record}
          autoplay={session.autoplay}
          busy={resolving}
          hasPrevious={!!previousEpisode}
          hasNext={!!nextEpisode}
          onEnded={() => {
            if (nextEpisode && usePreferences.getState().autoplay) chooseEpisode(nextEpisode, true);
          }}
          onPrevious={() => goTo(previousEpisode)}
          onNext={() => goTo(nextEpisode)}
        />
      ) : (
        <div
          className="video-stage grid place-items-center p-6 text-center text-sm text-white/70"
          style={placeholderStyle}
          aria-busy={resolving || undefined}
        >
          {resolving ? (
            <div role="status">
              <LoadingRing />
              <p>正在获取播放地址…</p>
              <p>来源解析可能需要一些时间，可切换剧集或返回取消。</p>
            </div>
          ) : playbackError ? (
            <div role="alert">
              <h2 className="mb-2 text-base font-medium text-white">暂时无法播放</h2>
              <p className="mb-3 max-w-[55ch] [overflow-wrap:anywhere]">{playbackError}</p>
              {selected && (
                <Button variant="secondary" onClick={() => void loadEpisode(selected, true, true)}>
                  重新获取地址
                </Button>
              )}
            </div>
          ) : (
            <p>{supportsPlayback ? '此剧目暂无可播放剧集。' : '此来源不提供在线播放。'}</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!previousEpisode || !supportsPlayback}
            onClick={() => goTo(previousEpisode)}
          >
            <SkipBack data-icon="inline-start" />
            上一集
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!nextEpisode || !supportsPlayback}
            onClick={() => goTo(nextEpisode)}
          >
            下一集
            <SkipForward data-icon="inline-end" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="autoplay-next" checked={autoplayNext} onCheckedChange={setAutoplay} aria-label="自动播放下一集" />
          <Label htmlFor="autoplay-next" className="font-normal">
            自动连播
          </Label>
        </div>
      </div>
      {!serverProxy && (
        <p className="text-xs text-muted-foreground">
          直链播放：视频由浏览器直接访问源站，不经过本站或上游中转。若跨域、防盗链或网络限制导致失败，可在设置中开启“服务器代理中转”。
        </p>
      )}
      {!!session?.record.position && (
        <p className="text-xs text-muted-foreground">
          已恢复到 {formatPosition(session.record.position)}。点击播放继续观看。
        </p>
      )}
      {media.description && (
        <Card size="sm">
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              剧情简介
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="max-w-prose leading-relaxed whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">
              {media.description}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
  const episodePanel = (
    <Card size="sm" role="complementary" aria-label="剧集选择">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          选集
        </CardTitle>
        <CardAction>
          <Badge variant="secondary" className="tabular-nums">
            {episodes.length} 集
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {seasons.length > 1 && (
          <Select value={String(seasonIndex)} onValueChange={(value) => setSeasonIndex(Number(value))}>
            <SelectTrigger aria-label="选择季" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {seasons.map((season, index) => (
                <SelectItem key={index} value={String(index)}>
                  {season.title || `第 ${season.seasonNumber} 季`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="grid max-h-80 grid-cols-4 gap-2 overflow-y-auto p-0.5 sm:grid-cols-[repeat(auto-fill,minmax(72px,1fr))] xl:max-h-[480px]">
          {seasons[seasonIndex]?.episodes.map((episode) => (
            <Button
              key={episode.id}
              variant={selectedId === episode.id ? 'default' : 'outline'}
              aria-pressed={selectedId === episode.id}
              disabled={!supportsPlayback}
              title={episode.title}
              onClick={() => chooseEpisode(episode)}
              size="sm"
              className="h-auto min-h-8 w-full px-1 py-1.5 text-xs whitespace-normal [overflow-wrap:anywhere]"
            >
              {episode.title}
            </Button>
          ))}
        </div>
        {!episodes.length && <EmptyState description="来源暂未提供剧集。" />}
      </CardContent>
    </Card>
  );

  return (
    <section aria-labelledby="watch-title" className="flex flex-col gap-4">
      {backLink}
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 id="watch-title" className="text-xl font-semibold tracking-tight">
            {media.title}
          </h1>
          <p className="text-sm text-muted-foreground">
            {source?.title}
            {selected && <span> / {selected.title}</span>}
          </p>
        </div>
        <Button
          variant={saved ? 'default' : 'outline'}
          disabled={favoriteBusy}
          aria-pressed={saved}
          onClick={onToggleFavorite}
          className="shrink-0"
        >
          {favoriteBusy ? <Spinner /> : <Star className={cn(saved && 'fill-current')} />}
          {saved ? '已收藏' : '收藏剧目'}
        </Button>
      </div>
      {/*
       * The player panel always stays the group's first child, so crossing the breakpoint (e.g. rotating a
       * tablet) never remounts the player. Wide screens add a resizable episode panel whose pixel width
       * survives window resizes and reloads; narrow screens stack the episode list below.
       */}
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="h-auto"
      >
        <ResizablePanel key="player" id="player" minSize={wide ? '480px' : undefined}>
          <div className={cn(wide && 'pr-4')}>{playColumn}</div>
        </ResizablePanel>
        {wide && <ResizableHandle key="handle" withHandle aria-label="调整选集面板宽度" />}
        {wide && (
          <ResizablePanel
            key="episodes"
            id="episodes"
            defaultSize="300px"
            minSize="240px"
            maxSize="480px"
            groupResizeBehavior="preserve-pixel-size"
          >
            <div className="pl-4">{episodePanel}</div>
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
      {!wide && episodePanel}
    </section>
  );
}
