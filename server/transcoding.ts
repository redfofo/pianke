import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

export interface TranscodeInput {
  id: string;
  userId: string;
  sourceId: string;
  mediaPath: string;
  accessToken: string;
}

export interface ProbeResult {
  container: string;
  runtimeTicks?: number;
  bitrate?: number;
  streams: {
    Index: number;
    Type: 'Video' | 'Audio' | 'Subtitle';
    Codec: string;
    Language?: string;
    Width?: number;
    Height?: number;
    Channels?: number;
    SampleRate?: number;
    IsDefault: boolean;
    IsExternal: boolean;
  }[];
}

interface TranscodeSession {
  id: string;
  input: TranscodeInput;
  directory: string;
  process: ChildProcess;
  startedAt: number;
  touchedAt: number;
  stderr: string;
}


export class TranscodingManager {
  private readonly directory = resolve(process.env.TRANSCODE_DIR || '/tmp/pianke-transcodes');
  private readonly sessions = new Map<string, TranscodeSession>();
  private readonly probes = new Map<string, { value: ProbeResult; expires: number }>();
  private readonly ready: Promise<void>;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(private readonly logger: FastifyBaseLogger) {
    this.ready = this.clearDirectory();
    this.cleanupTimer = setInterval(() => void this.cleanup(), 10 * 60_000);
    this.cleanupTimer.unref();
  }

  private async clearDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory);
    await Promise.all(entries.map(entry => rm(join(this.directory, entry), { recursive: true, force: true })));
  }

  private mediaUrl(input: TranscodeInput): string {
    const base = process.env.TRANSCODE_PROXY_BASE_URL || `http://127.0.0.1:${Number(process.env.PORT || 8788)}`;
    const separator = input.mediaPath.includes('?') ? '&' : '?';
    return `${base}${input.mediaPath}${separator}api_key=${encodeURIComponent(input.accessToken)}`;
  }

  async probe(input: TranscodeInput): Promise<ProbeResult | undefined> {
    const cached = this.probes.get(input.id);
    if (cached && cached.expires > Date.now()) return cached.value;
    // Proxied HLS segments (/api/media/<token>) carry no file extension; ffmpeg rejects them unless told not to.
    const args = ['-v', 'error', '-extension_picky', '0', '-show_entries', 'format=format_name,duration,bit_rate:stream=index,codec_type,codec_name,width,height,channels,sample_rate:stream_tags=language:stream_disposition=default', '-of', 'json', this.mediaUrl(input)];
    const child = spawn(process.env.FFPROBE_PATH || 'ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-8192); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', resolveExit);
    }).finally(() => clearTimeout(timer));
    if (code !== 0) {
      this.logger.warn({ inputId: input.id, code, stderr: errorOutput.replace(/api_key=[^&\s]+/g, 'api_key=*') }, 'ffprobe failed');
      return undefined;
    }
    const parsed = JSON.parse(output) as { format?: Record<string, string>; streams?: { index?: number; codec_type?: string; codec_name?: string; width?: number; height?: number; channels?: number; sample_rate?: string; tags?: { language?: string }; disposition?: { default?: number } }[] };
    const typeByCodec: Record<string, 'Video' | 'Audio' | 'Subtitle'> = { video: 'Video', audio: 'Audio', subtitle: 'Subtitle' };
    const result: ProbeResult = {
      container: String(parsed.format?.format_name || '').split(',')[0] || 'mp4',
      runtimeTicks: parsed.format?.duration ? Math.round(Number(parsed.format.duration) * 10_000_000) : undefined,
      bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : undefined,
      streams: (parsed.streams || []).flatMap(stream => {
        const type = typeByCodec[String(stream.codec_type || '')];
        if (!type) return [];
        return [{
          Index: Number(stream.index || 0), Type: type, Codec: String(stream.codec_name || 'unknown'),
          Language: stream.tags?.language, Width: stream.width, Height: stream.height, Channels: stream.channels,
          SampleRate: stream.sample_rate ? Number(stream.sample_rate) : undefined,
          IsDefault: stream.disposition?.default === 1, IsExternal: false,
        }];
      }),
    };
    this.probes.set(input.id, { value: result, expires: Date.now() + 6 * 60 * 60_000 });
    return result;
  }

  async playlist(input: TranscodeInput, startTimeTicks = 0): Promise<Buffer> {
    await this.ready;
    const sessionId = `${input.id}-${Math.max(0, Math.floor(startTimeTicks / 10_000_000))}`;
    let session = this.sessions.get(sessionId);
    if (!session) {
      const configured = Number(process.env.TRANSCODE_MAX_SESSIONS || 1);
      const maxSessions = Number.isInteger(configured) && configured > 0 ? configured : 1;
      if (this.sessions.size >= maxSessions) throw new Error('转码任务已满，请稍后重试');
      const directory = join(this.directory, sessionId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const codec = ['libx264', 'h264_qsv', 'h264_nvenc', 'h264_vaapi'].includes(process.env.TRANSCODE_VIDEO_CODEC || '') ? process.env.TRANSCODE_VIDEO_CODEC! : 'libx264';
      const args = ['-hide_banner', '-loglevel', 'warning'];
      if (startTimeTicks > 0) args.push('-ss', String(startTimeTicks / 10_000_000));
      args.push('-extension_picky', '0', '-i', this.mediaUrl(input), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', codec);
      if (codec === 'libx264') args.push('-preset', process.env.TRANSCODE_PRESET || 'veryfast');
      args.push('-c:a', 'aac', '-ac', '2', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_flags', 'independent_segments', '-hls_segment_filename', join(directory, 'segment-%06d.ts'), join(directory, 'index.m3u8'));
      const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const created: TranscodeSession = { id: sessionId, input, directory, process: child, startedAt: Date.now(), touchedAt: Date.now(), stderr: '' };
      session = created;
      this.sessions.set(sessionId, created);
      child.stderr?.on('data', (chunk: Buffer) => { created.stderr = (created.stderr + chunk.toString()).slice(-8192); });
      child.once('exit', (code: number | null) => {
        if (code && this.sessions.get(sessionId) === created) this.logger.warn({ code, sessionId, stderr: created.stderr }, 'ffmpeg transcoding failed');
      });
    }
    session.touchedAt = Date.now();
    const playlist = join(session.directory, 'index.m3u8');
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const info = await stat(playlist);
        if (info.size > 0) return await readFile(playlist);
      } catch {
        if (session.process.exitCode !== null) throw new Error(`转码启动失败：${session.stderr.slice(-1000)}`);
      }
      await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 100));
    }
    throw new Error('转码启动超时');
  }

  async segment(input: TranscodeInput, sessionId: string, file: string): Promise<Buffer> {
    if (!/^segment-\d{6}\.ts$/.test(file)) throw new Error('转码分片不存在');
    const session = this.sessions.get(sessionId);
    if (!session || session.input.id !== input.id || session.input.userId !== input.userId) throw new Error('转码会话不存在或已结束');
    session.touchedAt = Date.now();
    return readFile(join(session.directory, file));
  }

  sessionId(inputId: string, startTimeTicks: number): string {
    return `${inputId}-${Math.max(0, Math.floor(startTimeTicks / 10_000_000))}`;
  }

  status(): { id: string; sourceId: string; userId: string; startedAt: number; touchedAt: number }[] {
    return [...this.sessions.values()].map(session => ({ id: session.id, sourceId: session.input.sourceId, userId: session.input.userId, startedAt: session.startedAt, touchedAt: session.touchedAt }));
  }

  async cleanup(force = false): Promise<void> {
    const threshold = Date.now() - 2 * 60 * 60_000;
    for (const [id, session] of this.sessions) {
      if (!force && session.touchedAt >= threshold) continue;
      session.process.kill('SIGKILL');
      this.sessions.delete(id);
      await rm(session.directory, { recursive: true, force: true });
    }
    if (force) await this.clearDirectory();
  }

  async close(): Promise<void> {
    await this.ready;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    await this.cleanup(true);
  }
}
