import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Artplayer from 'artplayer';
import type Hls from 'hls.js/light';
import { Button } from '@/components/ui/button';
import { reportPlayback } from '../api';
import { useLibrary } from '../stores';
import { usePreferences } from '../preferences';
import type { PlaybackSource } from '../types';
import type { WatchRecord } from '../storage';
import { Notice } from './common';

// 线路重试由页面上的“重试此线路”负责，不使用 ArtPlayer 的自动重连。
Artplayer.RECONNECT_TIME_MAX = 0;

type QualityOption = { value: string; label: string; index: number; bitrate: number };

interface VideoPlayerProps {
  sources: PlaybackSource[];
  record: WatchRecord;
  autoplay: boolean;
  busy?: boolean;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onEnded: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

interface PlayerController {
  loadedRecord: WatchRecord;
  loadEpisode: () => void;
  loadLine: (preservePlayback?: boolean) => void;
  syncTrackActions: () => void;
}

// Lock-screen / notification controls on phones, and hardware media keys on desktops.
const mediaSession =
  typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : undefined;
function setAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  try {
    mediaSession?.setActionHandler(action, handler);
  } catch {
    /* Action not supported by this browser. */
  }
}
function isHls(source: PlaybackSource) {
  return /mpegurl/i.test(source.type) || /\.m3u8$/i.test(new URL(source.src, location.href).pathname);
}

export function VideoPlayer(props: VideoPlayerProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const controller = useRef<PlayerController>(undefined);
  const [error, setError] = useState('');
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [reportingError, setReportingError] = useState('');
  const [ratio, setRatio] = useState(() => usePreferences.getState().videoRatio || 0);

  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const { saveWatch } = useLibrary.getState();
    let record = { ...latest.current.record };
    let art: Artplayer | undefined;
    let hls: Hls | undefined;
    let line = 0;
    let quality = 'auto';
    let qualities: QualityOption[] = [];
    let ready = false;
    let lastSaved = 0;
    let resumeAt = record.position;
    let changing = false;
    let wantsPlay = latest.current.autoplay;
    let reported: boolean | undefined;
    let disposed = false;
    let loadToken = 0;

    const sources = () => latest.current.sources;
    const lineTitle = (index: number) => sources()[index]?.title || `线路 ${index + 1}`;
    function syncLineSetting() {
      if (!art) return;
      if (art.setting.find('line')) art.setting.remove('line');
      if (sources().length < 2) return;
      art.setting.update({
        name: 'line',
        html: '播放线路',
        tooltip: lineTitle(line),
        selector: sources().map((_, index) => ({ html: lineTitle(index), index, default: index === line })),
        onSelect(item) {
          line = item.index;
          loadLine();
          return item.html;
        },
      });
    }
    function saveProgress(force = false) {
      if (!art || changing || !ready || resumeAt > 0) return;
      const now = Date.now();
      if (!force && now - lastSaved < 5000) return;
      const position = art.currentTime || 0;
      const duration = art.duration || 0;
      if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
      lastSaved = now;
      void saveWatch({ ...record, position, duration, updatedAt: now });
    }
    function restorePosition() {
      if (!art || resumeAt <= 0 || disposed) return;
      const duration = art.duration || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const position = Math.min(resumeAt, Math.max(0, duration - 0.25));
      resumeAt = 0;
      art.currentTime = position;
    }
    function updateRatio() {
      const video = art?.video;
      if (!video || !video.videoWidth || !video.videoHeight) return;
      const value = Math.round((video.videoWidth / video.videoHeight) * 1000) / 1000;
      setRatio(value);
      usePreferences.getState().setVideoRatio(value);
    }
    function report(ok: boolean, message: string) {
      if (reported === ok) return;
      reported = ok;
      void reportPlayback(record.sourceId, ok, message).catch((reason) => {
        if (!disposed)
          setReportingError(`播放状态未能上报：${reason instanceof Error ? reason.message : String(reason)}`);
      });
    }
    function fail(message: string) {
      setError(message);
      report(false, message);
    }
    function destroyHls() {
      hls?.destroy();
      hls = undefined;
    }
    function selectQuality() {
      if (!hls) return;
      hls.currentLevel = qualities.find((option) => option.value === quality)?.index ?? -1;
    }
    function syncQualities() {
      if (!art || !hls) return;
      const byValue = new Map<string, QualityOption>();
      hls.levels.forEach((level, index) => {
        const value = String(level.height || level.bitrate);
        const existing = byValue.get(value);
        if (existing && existing.bitrate >= level.bitrate) return;
        byValue.set(value, {
          value,
          index,
          bitrate: level.bitrate,
          label: level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps`,
        });
      });
      qualities = [...byValue.values()].sort((a, b) => Number(b.value) - Number(a.value));
      if (qualities.length < 2) {
        if (art.setting.find('quality')) art.setting.remove('quality');
        return;
      }
      art.setting.update({
        name: 'quality',
        html: '清晰度',
        tooltip: qualities.find((option) => option.value === quality)?.label || '自动',
        selector: [
          { html: '自动', value: 'auto', default: quality === 'auto' },
          ...qualities.map((option) => ({
            html: option.label,
            value: option.value,
            default: option.value === quality,
          })),
        ],
        onSelect(item) {
          quality = item.value;
          selectQuality();
          return item.html;
        },
      });
      selectQuality();
    }
    async function playHls(video: HTMLVideoElement, url: string) {
      const token = loadToken;
      // The light build drops DRM, subtitles and alternate audio, none of which short-drama sources use.
      const { default: HlsPlayer } = await import('hls.js/light');
      if (disposed || token !== loadToken) return;
      if (!HlsPlayer.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = url;
        else fail('当前浏览器不支持 HLS 播放，请更换浏览器或切换其他视频源。');
        return;
      }
      destroyHls();
      const instance = new HlsPlayer();
      let mediaRecovered = false;
      hls = instance;
      instance.on(HlsPlayer.Events.MANIFEST_PARSED, syncQualities);
      instance.on(HlsPlayer.Events.ERROR, (_, data) => {
        if (!data.fatal || hls !== instance || disposed) return;
        if (data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
          mediaRecovered = true;
          instance.recoverMediaError();
          return;
        }
        destroyHls();
        if (art) art.loading.show = false;
        fail(`播放失败（${data.details}）：${data.error?.message || 'HLS 流无法加载，请重试或切换来源。'}`);
      });
      instance.loadSource(url);
      instance.attachMedia(video);
    }
    function loadLine(preservePlayback = true) {
      if (!art) return;
      if (preservePlayback && ready) {
        saveProgress(true);
        resumeAt = art.currentTime || 0;
        wantsPlay = art.playing;
      }
      loadToken++;
      changing = true;
      ready = false;
      setError('');
      reported = undefined;
      setAutoplayBlocked(false);
      qualities = [];
      quality = 'auto';
      if (art.setting.find('quality')) art.setting.remove('quality');
      art.pause();
      destroyHls();
      const selected = sources()[line];
      if (!selected) {
        setError('来源没有返回可播放的线路。');
        return;
      }
      art.option.type = isHls(selected) ? 'm3u8' : undefined;
      art.url = selected.src;
    }
    function syncTrackActions() {
      setAction('previoustrack', latest.current.hasPrevious ? () => latest.current.onPrevious() : null);
      setAction('nexttrack', latest.current.hasNext ? () => latest.current.onNext() : null);
    }
    function setupMediaSession() {
      if (!mediaSession || typeof MediaMetadata === 'undefined') return;
      mediaSession.metadata = new MediaMetadata({
        title: record.episodeTitle || record.title,
        artist: record.title,
        album: '片刻',
        artwork: record.posterUrl ? [{ src: record.posterUrl }] : [],
      });
      setAction('play', () => void art?.play());
      setAction('pause', () => art?.pause());
      setAction('seekbackward', (details) => {
        if (art) art.currentTime = Math.max(0, art.currentTime - (details.seekOffset || 10));
      });
      setAction('seekforward', (details) => {
        if (art) art.currentTime = Math.min(art.duration || Infinity, art.currentTime + (details.seekOffset || 10));
      });
      setAction('seekto', (details) => {
        if (art && details.seekTime !== undefined) art.currentTime = details.seekTime;
      });
      syncTrackActions();
    }
    function clearMediaSession() {
      if (!mediaSession) return;
      for (const action of [
        'play',
        'pause',
        'seekbackward',
        'seekforward',
        'seekto',
        'previoustrack',
        'nexttrack',
      ] as const)
        setAction(action, null);
      mediaSession.metadata = null;
      mediaSession.playbackState = 'none';
    }
    const self: PlayerController = {
      loadedRecord: latest.current.record,
      loadLine,
      syncTrackActions,
      loadEpisode() {
        if (!art) return;
        saveProgress(true);
        self.loadedRecord = latest.current.record;
        record = { ...latest.current.record };
        line = 0;
        resumeAt = record.position;
        wantsPlay = latest.current.autoplay;
        art.video.setAttribute('aria-label', `${record.title} ${record.episodeTitle}`);
        setupMediaSession();
        syncLineSetting();
        loadLine(false);
      },
    };
    controller.current = self;

    art = new Artplayer({
      container,
      url: '',
      lang: 'zh-cn',
      theme: '#76c9b2',
      setting: true,
      playbackRate: true,
      hotkey: true,
      pip: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      playsInline: true,
      lock: true,
      gesture: true,
      fastForward: true,
      autoOrientation: true,
      autoPlayback: false,
      moreVideoAttr: { preload: 'metadata' },
      settings: [],
      customType: { m3u8: playHls },
    });
    art.video.setAttribute('aria-label', `${record.title} ${record.episodeTitle}`);
    art.on('video:loadedmetadata', () => {
      if (!art || disposed) return;
      updateRatio();
      restorePosition();
      changing = false;
      ready = true;
      if (wantsPlay)
        void art.play().catch(() => {
          if (!disposed) setAutoplayBlocked(true);
        });
    });
    art.on('video:loadeddata', updateRatio);
    art.on('video:durationchange', restorePosition);
    art.on('video:timeupdate', () => saveProgress());
    art.on('video:pause', () => {
      if (mediaSession) mediaSession.playbackState = 'paused';
      saveProgress(true);
    });
    art.on('video:seeked', () => saveProgress(true));
    art.on('video:playing', () => {
      setAutoplayBlocked(false);
      if (mediaSession) mediaSession.playbackState = 'playing';
      const video = art?.video;
      if (video && video.videoWidth === 0 && video.readyState >= 2) {
        art?.pause();
        fail(
          '当前浏览器未解码出视频画面，可能不支持源视频编码（例如 HEVC/H.265）。请使用支持该编码的浏览器或切换其他视频源；本服务不转码。',
        );
        return;
      }
      if (video && video.videoWidth > 0)
        report(true, `浏览器已实际播放：${record.episodeTitle}（${sources()[line]?.title || '默认线路'}）`);
    });
    art.on('video:error', () => {
      const failure = art?.video.error;
      if (!failure) return;
      fail(`播放失败（${failure.code}）：${failure.message || '视频无法加载，请重试或切换来源。'}`);
    });
    art.on('video:ended', () => {
      saveProgress(true);
      latest.current.onEnded();
    });
    const pageHide = () => saveProgress(true);
    const visibilityChange = () => {
      if (document.visibilityState === 'hidden') saveProgress(true);
    };
    window.addEventListener('pagehide', pageHide);
    document.addEventListener('visibilitychange', visibilityChange);
    // A narrow player (phones, portrait videos) cannot fit every control; ArtPlayer would push the rightmost
    // ones, fullscreen first, out of view. Drop optional controls in this order until the rest fit.
    const optionalControls = ['volume', 'pip', 'fullscreenWeb', 'time'];
    const fitControls = () => {
      const player = art?.template.$player;
      const right = player?.querySelector('.art-controls-right');
      if (!player || !right) return;
      const controls = optionalControls
        .map((name) => player.querySelector(`.art-control-${name}`))
        .filter((control) => control !== null);
      for (const control of controls) control.classList.remove('art-control-overflow');
      const fits = () => right.getBoundingClientRect().right <= player.getBoundingClientRect().right + 0.5;
      for (const control of controls) {
        if (fits()) break;
        control.classList.add('art-control-overflow');
      }
    };
    const resizeObserver = new ResizeObserver(fitControls);
    resizeObserver.observe(art.template.$player);
    // Longer durations (1:23:45) widen the time control.
    art.on('video:durationchange', fitControls);
    setupMediaSession();
    syncLineSetting();
    loadLine(false);

    return () => {
      saveProgress(true);
      disposed = true;
      resizeObserver.disconnect();
      window.removeEventListener('pagehide', pageHide);
      document.removeEventListener('visibilitychange', visibilityChange);
      clearMediaSession();
      destroyHls();
      art?.destroy();
      art = undefined;
      controller.current = undefined;
    };
  }, []);

  // A new episode reuses the same ArtPlayer, so fullscreen and the player UI survive autoplay.
  useEffect(() => {
    const current = controller.current;
    if (current && current.loadedRecord !== props.record) current.loadEpisode();
  }, [props.record]);
  useEffect(() => {
    controller.current?.syncTrackActions();
  }, [props.hasPrevious, props.hasNext]);

  const stageStyle = ratio ? ({ '--video-ratio': String(ratio) } as CSSProperties) : undefined;
  return (
    <div aria-busy={props.busy || undefined}>
      <div className="video-stage" style={stageStyle}>
        <div ref={host} className="absolute inset-0 size-full" />
      </div>
      {autoplayBlocked && (
        <Notice tone="info" title="浏览器已阻止自动播放，请点击播放器中的播放按钮。" className="mt-3.5 mb-0" />
      )}
      {error && (
        <Notice title={error} className="mt-3.5 mb-0">
          <Button variant="outline" onClick={() => controller.current?.loadLine()}>
            重试此线路
          </Button>
        </Notice>
      )}
      {reportingError && <Notice tone="warning" title={reportingError} className="mt-3.5 mb-0" />}
    </div>
  );
}
