import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canAccessSource, queryToken, type AccountDatabase, type User } from './accounts.js';
import { Catalog, type CatalogItem, type CatalogQuery, type UserItemData } from './catalog.js';
import { ConfigError } from './config.js';
import { resolvePlayback } from './providers.js';
import { grantPlayback, preparePlayback, rememberSourceType } from './media.js';
import { TranscodingManager, type ProbeResult, type TranscodeInput } from './transcoding.js';
import type { Detail, PlaybackSource } from '../src/types.js';
import { episodeKey, recordKey, toRecent, type FavoriteRecord, type WatchRecord } from '../src/storage.js';

interface ClientIdentity {
  token: string;
  userId: string;
  client: string;
  device: string;
  deviceId: string;
  version: string;
}

interface TokenRow {
  userId: string;
  deviceId: string;
  client: string;
  deviceName: string;
  version: string;
}

interface PosterService {
  decorate<T extends { sourceId: string; link: string; title: string; posterUrl: string }>(item: T): T;
  serve(request: FastifyRequest, reply: FastifyReply, id: string, cacheControl?: string, anonymous?: boolean): Promise<unknown>;
}

interface PlaybackGrant {
  mediaSourceId: string;
  itemId: string;
  userId: string;
  sourceId: string;
  path: string;
  type: string;
  title: string;
  expires: number;
  playSessionId: string;
  accessToken: string;
}

/** Resolved, preflighted and (eventually) probed sources of one playable item for one user. */
interface PreparedPlayback {
  playable: PlaybackSource[];
  probes: Promise<(ProbeResult | undefined)[]>;
  candidates: number;
  preflight: boolean;
  resolveMs: number;
  prepareMs: number;
}

interface ActiveSession {
  id: string;
  userId: string;
  userName: string;
  client: string;
  deviceName: string;
  deviceId: string;
  version: string;
  lastActivityAt: number;
  itemId?: string;
  positionTicks: number;
  paused: boolean;
  playSessionId?: string;
}

const serverVersion = '4.8.10.0';
/**
 * How long PlaybackInfo waits for ffprobe before answering without stream details. Enough for progressive
 * files; a cold HLS probe takes seconds and keeps running for the next request instead of delaying this one.
 */
const probeBudgetMs = 250;
/** Matches the provider detail cache, so a reused preparation is never older than a fresh resolve would be. */
const preparedLifetime = 5 * 60_000;
const maxWarmups = 2;
const embyRoots = ['/System/', '/Users', '/Items', '/Shows', '/Videos', '/Sessions', '/Library', '/DisplayPreferences', '/UserSettings', '/Search', '/Movies', '/Branding', '/QuickConnect', '/Localization', '/socket'];
// Emby routing is case-insensitive (clients request e.g. /emby/videos/...), so paths are compared lowercased.
// Image loaders fetch artwork without auth headers, as real Emby allows; such requests must carry the item's current tag.
const imagePath = /^\/items\/[^/]+\/images\/[^/]+(\/[^/]+)?$/;
const publicPaths = new Set(['/System/Info/Public', '/System/Ping', '/Users/Public', '/Users/AuthenticateByName', '/QuickConnect/Enabled', '/Branding/Configuration', '/Localization/Cultures', '/Localization/Options'].map(path => path.toLowerCase()));

function routePaths(path: string): string[] {
  return [path, `/emby${path}`];
}

function normalizedPath(url: string): string {
  const path = url.split('?')[0]!.toLowerCase();
  return path.startsWith('/emby/') ? path.slice(5) : path;
}

export function isEmbyPath(url: string): boolean {
  const path = normalizedPath(url);
  return embyRoots.some(root => { root = root.toLowerCase(); return path === root.slice(0, -1) || path.startsWith(root); });
}

function headerIdentity(request: FastifyRequest): ClientIdentity {
  const header = String(request.headers['x-emby-authorization'] || request.headers.authorization || '');
  const fields: Record<string, string> = {};
  for (const match of header.matchAll(/([A-Za-z]+)="([^"]*)"/g)) fields[match[1]!.toLowerCase()] = match[2]!;
  const query = request.query && typeof request.query === 'object' ? request.query as Record<string, unknown> : {};
  const token = String(request.headers['x-emby-token'] || fields.token || queryToken(query) || '');
  return {
    token,
    userId: fields.userid || '',
    client: (fields.client || String(request.headers['user-agent'] || 'Unknown')).slice(0, 200),
    device: (fields.device || 'Unknown Device').slice(0, 200),
    deviceId: (fields.deviceid || String(query.deviceId || 'unknown')).slice(0, 200),
    version: (fields.version || '0').slice(0, 50),
  };
}

function publicUser(user: User, serverId: string) {
  return {
    Name: user.username,
    ServerId: serverId,
    ServerName: process.env.SERVER_NAME || '片刻',
    Id: user.id,
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    LastLoginDate: new Date().toISOString(),
    LastActivityDate: new Date().toISOString(),
    DateCreated: new Date(user.createdAt).toISOString(),
    Configuration: {
      AudioLanguagePreference: 'chi', SubtitleLanguagePreference: 'chi', PlayDefaultAudioTrack: true,
      SubtitleMode: 'Default', DisplayMissingEpisodes: false, EnableNextEpisodeAutoPlay: true,
    },
    Policy: {
      IsAdministrator: user.role === 'admin', IsDisabled: false, EnableRemoteAccess: true,
      EnableMediaPlayback: true, EnableVideoPlaybackTranscoding: true, EnableAudioPlaybackTranscoding: true,
      EnablePlaybackRemuxing: true, EnableContentDownloading: false, EnableAllDevices: true,
      EnableAllFolders: user.role === 'admin', EnabledFolders: user.sourceIds.map(Catalog.libraryId),
    },
  };
}

function sessionInfo(identity: ClientIdentity, user: User, serverId: string, id: string, now: number, remoteEndPoint: string) {
  const date = new Date(now).toISOString();
  const supportedCommands: string[] = [];
  const playableMediaTypes = ['Audio', 'Video'];
  return {
    PlayState: { CanSeek: false, IsPaused: false, IsMuted: false, PositionTicks: 0, PlaybackStartTimeTicks: 0, VolumeLevel: 100, AudioStreamIndex: null, SubtitleStreamIndex: null, MediaSourceId: '', PlayMethod: 'DirectPlay', RepeatMode: 'RepeatNone' },
    AdditionalUsers: [],
    Capabilities: { PlayableMediaTypes: playableMediaTypes, SupportedCommands: supportedCommands, SupportsMediaControl: false, SupportsPersistentIdentifier: true },
    RemoteEndPoint: remoteEndPoint,
    PlayableMediaTypes: playableMediaTypes,
    Id: id,
    UserId: user.id,
    UserName: user.username,
    Client: identity.client,
    LastActivityDate: date,
    LastPlaybackCheckIn: date,
    DeviceName: identity.device,
    DeviceType: identity.device,
    DeviceId: identity.deviceId,
    ApplicationVersion: identity.version,
    IsActive: true,
    SupportsMediaControl: false,
    SupportsRemoteControl: false,
    NowPlayingQueue: [],
    HasCustomDeviceName: false,
    ServerId: serverId,
    SupportedCommands: supportedCommands,
  };
}

function userDataDto(itemId: string, data?: UserItemData) {
  const percentage = data?.runtimeTicks ? Math.min(100, (data.positionTicks / data.runtimeTicks) * 100) : 0;
  return {
    PlaybackPositionTicks: data?.positionTicks || 0,
    PlayCount: data?.playCount || 0,
    IsFavorite: !!data?.favorite,
    Played: !!data?.played,
    Key: itemId,
    PlayedPercentage: percentage,
    ...(data?.lastPlayedAt ? { LastPlayedDate: new Date(data.lastPlayedAt).toISOString() } : {}),
  };
}

function imageTag(item: CatalogItem): string | undefined {
  return item.posterUrl.match(/\/api\/posters\/([a-f0-9]{64})/)?.[1];
}

function itemDto(catalog: Catalog, user: User, item: CatalogItem) {
  const data = catalog.userData(user.id, item.id);
  const parent = item.parentId ? catalog.get(item.parentId) : undefined;
  const series = catalog.findSeries(item);
  const tag = imageTag(item);
  const children = item.type === 'Series' ? catalog.children(item.id) : [];
  return {
    Name: item.name,
    ServerId: catalog.serverId,
    Id: item.id,
    Etag: `${item.updatedAt.toString(16)}-${item.detailAt.toString(16)}`,
    DateCreated: new Date(item.createdAt).toISOString(),
    DateModified: new Date(item.updatedAt).toISOString(),
    SortName: item.name,
    Overview: item.overview,
    IsFolder: ['CollectionFolder', 'Series', 'Season'].includes(item.type),
    Type: item.type,
    MediaType: item.type === 'Episode' || item.type === 'Movie' ? 'Video' : undefined,
    CollectionType: item.type === 'CollectionFolder' ? 'tvshows' : undefined,
    ParentId: item.parentId || undefined,
    IndexNumber: item.indexNumber ?? undefined,
    ParentIndexNumber: item.parentIndexNumber ?? undefined,
    SeriesId: series && series.id !== item.id ? series.id : undefined,
    SeriesName: series && series.id !== item.id ? series.name : undefined,
    SeasonId: parent?.type === 'Season' ? parent.id : undefined,
    SeasonName: parent?.type === 'Season' ? parent.name : undefined,
    ChildCount: item.type === 'Series' ? children.length : undefined,
    SeasonCount: item.type === 'Series' ? children.filter(child => child.type === 'Season').length : undefined,
    SupportsResume: item.type === 'Episode' || item.type === 'Movie',
    RunTimeTicks: data?.runtimeTicks || undefined,
    CanDelete: false,
    CanDownload: false,
    PlayAccess: 'Full',
    LocationType: 'Remote',
    ImageTags: tag ? { Primary: tag } : {},
    PrimaryImageAspectRatio: 0.72,
    UserData: userDataDto(item.id, data),
    // Clients enable their play button from MediaSources; the real streams are negotiated by PlaybackInfo.
    ...(item.type === 'Episode' || item.type === 'Movie' ? {
      MediaSources: [{
        Protocol: 'Http', Id: item.id, Type: 'Default', Name: item.name, IsRemote: true,
        SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true, SupportsProbing: true,
        RunTimeTicks: data?.runtimeTicks || undefined, MediaStreams: [],
      }],
      MediaStreams: [],
    } : {}),
  };
}

function queryValues(input: Record<string, unknown>): CatalogQuery {
  const list = (value: unknown) => typeof value === 'string' ? value.split(',').filter(Boolean) : [];
  const filters = list(input.Filters);
  return {
    parentId: typeof input.ParentId === 'string' ? input.ParentId : undefined,
    recursive: String(input.Recursive).toLowerCase() === 'true',
    search: typeof input.SearchTerm === 'string' ? input.SearchTerm.trim().slice(0, 200) : undefined,
    includeTypes: list(input.IncludeItemTypes),
    excludeTypes: list(input.ExcludeItemTypes),
    ids: list(input.Ids),
    favorite: input.IsFavorite !== undefined ? String(input.IsFavorite).toLowerCase() === 'true' : filters.includes('IsFavorite') ? true : undefined,
    played: input.IsPlayed !== undefined ? String(input.IsPlayed).toLowerCase() === 'true' : filters.includes('IsPlayed') ? true : filters.includes('IsUnplayed') ? false : undefined,
    resumable: filters.includes('IsResumable') ? true : undefined,
    sortBy: typeof input.SortBy === 'string' ? input.SortBy : undefined,
    descending: String(input.SortOrder).toLowerCase() === 'descending',
    start: Math.max(0, Number(input.StartIndex || 0) || 0),
    limit: Math.min(1000, Math.max(0, Number(input.Limit ?? 100) || 0)),
  };
}

export function registerEmbyRoutes(
  app: FastifyInstance,
  accounts: AccountDatabase,
  catalog: Catalog,
  posters: PosterService,
  loadDetail: (sourceId: string, link: string) => Promise<Detail>,
): void {
  const attempts = new Map<string, { count: number; expires: number }>();
  const playbackGrants = new Map<string, PlaybackGrant>();
  /** Latest negotiated source per user and item, for clients that stream with the item id as MediaSourceId. */
  const itemGrants = new Map<string, string>();
  const preparations = new Map<string, { value: Promise<PreparedPlayback>; expires: number }>();
  let warmups = 0;
  const itemCounts = new Map<string, { value: Record<string, number>; expires: number }>();
  const activeSessions = new Map<string, ActiveSession>();
  const transcoder = new TranscodingManager(app.log);
  app.addHook('onClose', async () => transcoder.close());

  app.addHook('onRequest', async (request, reply) => {
    if (!isEmbyPath(request.url)) return;
    const path = normalizedPath(request.url);
    reply.header('Cache-Control', 'private, no-store').header('X-Application-Error-Code', '');
    if (request.method === 'OPTIONS') return;
    if (publicPaths.has(path)) return;
    const identity = headerIdentity(request);
    if (!identity.token && request.method === 'GET' && imagePath.test(path)) return;
    if (!identity.token || !/^[A-Za-z0-9_-]{20,128}$/.test(identity.token)) return reply.code(401).send({ ErrorCode: 'Unauthorized', Message: 'Authentication token is required' });
    const row = catalog.db.prepare(`SELECT userId, deviceId, client, deviceName, version FROM emby_tokens
      WHERE tokenHash = ?`).get(Catalog.tokenHash(identity.token)) as TokenRow | undefined;
    const user = row ? accounts.getUser(row.userId) : undefined;
    if (!user) return reply.code(401).send({ ErrorCode: 'Unauthorized', Message: 'Access token is invalid' });
    if (identity.userId && identity.userId !== user.id) return reply.code(403).send({ ErrorCode: 'Forbidden', Message: 'User does not match access token' });
    request.account = user;
    catalog.db.prepare('UPDATE emby_tokens SET lastUsedAt = ? WHERE tokenHash = ?').run(Date.now(), Catalog.tokenHash(identity.token));
  });

  for (const path of routePaths('/System/Info/Public')) app.get(path, async request => ({
    LocalAddress: `${request.protocol}://${request.headers.host || 'localhost:8789'}`,
    ServerName: process.env.SERVER_NAME || '片刻', Version: serverVersion, ProductName: '片刻媒体服务器',
    OperatingSystem: process.platform, Id: catalog.serverId, StartupWizardCompleted: true,
  }));
  for (const path of routePaths('/System/Info')) app.get(path, async request => ({
    LocalAddress: `${request.protocol}://${request.headers.host || 'localhost:8789'}`,
    WanAddress: '', ServerName: process.env.SERVER_NAME || '片刻', Version: serverVersion,
    ProductName: '片刻媒体服务器', OperatingSystem: process.platform, Id: catalog.serverId,
    HasPendingRestart: false, IsShuttingDown: false, SupportsLibraryMonitor: false,
    WebSocketPortNumber: Number(process.env.PORT || 8789), CompletedInstallations: [],
  }));
  for (const path of routePaths('/System/Endpoint')) app.get(path, async request => ({
    IsLocal: true, IsInNetwork: true, RemoteEndPoint: request.ip,
  }));
  for (const path of routePaths('/System/Ping')) {
    app.get(path, async (_request, reply) => reply.type('text/plain').send('MediaBrowser Server is running'));
    app.post(path, async (_request, reply) => reply.type('text/plain').send('MediaBrowser Server is running'));
  }
  for (const path of routePaths('/Users/Public')) app.get(path, async () => []);
  for (const path of routePaths('/QuickConnect/Enabled')) app.get(path, async () => false);
  for (const path of routePaths('/Branding/Configuration')) app.get(path, async () => ({
    LoginDisclaimer: '请使用管理员创建的片刻账号登录。',
    CustomCss: '',
  }));
  for (const path of routePaths('/Localization/Cultures')) app.get(path, async () => [
    { Name: 'Chinese', DisplayName: '中文', ThreeLetterISOLanguageName: 'zho', TwoLetterISOLanguageName: 'zh' },
    { Name: 'English', DisplayName: 'English', ThreeLetterISOLanguageName: 'eng', TwoLetterISOLanguageName: 'en' },
  ]);
  for (const path of routePaths('/Localization/Options')) app.get(path, async () => [
    { Name: '中文', Value: 'zh-CN' },
    { Name: 'English', Value: 'en-US' },
  ]);

  for (const path of routePaths('/Users/AuthenticateByName')) app.post(path, async (request, reply) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
    const previous = attempts.get(request.ip);
    if (previous && previous.count >= 10) return reply.header('Retry-After', '900').code(429).send({ ErrorCode: 'RateLimitExceeded', Message: 'Too many login attempts' });
    attempts.set(request.ip, { count: (previous?.count || 0) + 1, expires: previous?.expires || now + 15 * 60_000 });
    const body = request.body as Record<string, unknown> | null;
    const username = typeof body?.Username === 'string' ? body.Username : typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.Pw === 'string' ? body.Pw : typeof body?.pw === 'string' ? body.pw : '';
    const user = await accounts.authenticateCredentials(username, password);
    if (!user) return reply.code(401).send({ ErrorCode: 'InvalidAuth', Message: 'Invalid username or password' });
    attempts.delete(request.ip);
    const identity = headerIdentity(request);
    const token = randomBytes(32).toString('base64url');
    catalog.db.prepare('INSERT INTO emby_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Catalog.tokenHash(token), user.id, identity.deviceId, identity.client, identity.device, identity.version, now, now);
    const sessionId = Catalog.tokenHash(token).slice(0, 32);
    return {
      User: publicUser(user, catalog.serverId),
      SessionInfo: sessionInfo(identity, user, catalog.serverId, sessionId, now, request.ip),
      AccessToken: token,
      ServerId: catalog.serverId,
    };
  });

  for (const path of routePaths('/Sessions/Logout')) app.post(path, async request => {
    const token = headerIdentity(request).token;
    if (token) catalog.db.prepare('DELETE FROM emby_tokens WHERE tokenHash = ?').run(Catalog.tokenHash(token));
    return {};
  });

  async function playbackTarget(user: User, requestedId: string): Promise<{ requested: CatalogItem; target: CatalogItem }> {
    let requested = catalog.get(requestedId);
    if (!requested || !canAccessSource(user, requested.sourceId)) throw new ConfigError('Playable item not found', 404);
    if (requested.type === 'Movie') {
      if (requested.detailAt === 0 || !catalog.children(requested.id).length) await ensureDetail(requested);
      requested = catalog.get(requestedId) || requested;
      const target = catalog.children(requested.id).find(item => item.type === 'Episode');
      if (!target) throw new ConfigError('Playable media is unavailable', 404);
      return { requested, target };
    }
    if (requested.type !== 'Episode') throw new ConfigError('Item is not playable', 400);
    return { requested, target: requested };
  }

  /** Single-flight, briefly cached resolve + preflight + probe, shared by repeated PlaybackInfo calls and warm-ups. */
  function preparePlayable(user: User, target: CatalogItem, accessToken: string): Promise<PreparedPlayback> {
    const key = `${user.id}\0${target.id}`;
    const cached = preparations.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    for (const [stale, entry] of preparations) if (entry.expires <= Date.now()) preparations.delete(stale);
    const value = (async (): Promise<PreparedPlayback> => {
      const started = performance.now();
      const candidates = await resolvePlayback(target.sourceId, target.link, target.upstreamId);
      const resolvedAt = performance.now();
      const scope = { userId: user.id, sourceId: target.sourceId };
      // A lone candidate has nothing to choose between, so skip its preflight when the type is known.
      const direct = candidates.length === 1 ? grantPlayback(candidates[0]!, scope) : undefined;
      const settled: PromiseSettledResult<PlaybackSource>[] = direct
        ? [{ status: 'fulfilled', value: direct }]
        : await Promise.allSettled(candidates.map(candidate => preparePlayback(candidate, scope)));
      const playable = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (!playable.length) {
        const failure = settled.find(result => result.status === 'rejected');
        throw failure?.reason || new Error('No playable media source is available');
      }
      // The grant path is stable for the lifetime of this preparation, so it keys the probe cache.
      const probes = Promise.all(playable.map(source => transcoder.probe({ id: source.src, userId: user.id, sourceId: target.sourceId, mediaPath: source.src, accessToken })
        .catch(() => undefined)));
      void probes.then(results => {
        const runtimeTicks = results.find(result => result?.runtimeTicks)?.runtimeTicks;
        if (runtimeTicks) catalog.patchUserData(user.id, target.id, { runtimeTicks });
        // The probed container corrects the remembered type used to skip later preflights.
        const container = results[0]?.container;
        if (container && !candidates[0]!.type) rememberSourceType(target.sourceId, container === 'hls' ? 'application/x-mpegURL' : 'video/mp4');
      });
      return { playable, probes, candidates: candidates.length, preflight: !direct, resolveMs: Math.round(resolvedAt - started), prepareMs: Math.round(performance.now() - resolvedAt) };
    })();
    const entry = { value, expires: Date.now() + preparedLifetime };
    preparations.set(key, entry);
    value.catch(() => { if (preparations.get(key) === entry) preparations.delete(key); });
    return value;
  }

  /** Prepare the item a detail page is about to play, so pressing play does not wait for the upstream. */
  function warmPlayback(request: FastifyRequest, item: CatalogItem | undefined): void {
    const account = request.account;
    const accessToken = headerIdentity(request).token;
    if (!account || !item || !accessToken || warmups >= maxWarmups || !['Episode', 'Movie'].includes(item.type)) return;
    warmups++;
    void playbackTarget(account, item.id)
      .then(({ target }) => preparePlayable(account, target, accessToken).then(prepared => prepared.probes))
      .catch(error => request.log.debug({ err: error, itemId: item.id }, 'Playback warm-up failed'))
      .finally(() => { warmups--; });
  }

  async function playbackInfo(request: FastifyRequest) {
    if (!request.account) throw new ConfigError('Authentication required', 401);
    const params = request.params as { id: string };
    const started = performance.now();
    const { requested, target } = await playbackTarget(request.account, params.id);
    const identity = headerIdentity(request);
    const pending = preparePlayable(request.account, target, identity.token);
    const { playable, probes: probing, ...preparation } = await pending;
    const preparedAt = performance.now();
    const probes = await Promise.race([probing, delay(probeBudgetMs, undefined, { ref: false })]);
    const playSessionId = randomBytes(16).toString('hex');
    const expires = Date.now() + 6 * 60 * 60_000;
    for (const [id, grant] of playbackGrants) if (grant.expires <= Date.now()) playbackGrants.delete(id);
    const userId = request.account.id;
    const mediaSources = playable.map((source, index) => {
      const mediaSourceId = randomBytes(16).toString('hex');
      playbackGrants.set(mediaSourceId, {
        mediaSourceId, itemId: requested.id, userId, sourceId: target.sourceId,
        path: source.src, type: source.type, title: source.title, expires, playSessionId, accessToken: identity.token,
      });
      const probe = probes?.[index];
      const hls = /mpegurl/i.test(source.type);
      const extension = hls ? 'm3u8' : 'mp4';
      // Unprefixed like real Emby: clients join these onto a base URL that may already end in /emby.
      const streamUrl = `/Videos/${encodeURIComponent(requested.id)}/stream.${extension}?Static=true&MediaSourceId=${mediaSourceId}&PlaySessionId=${playSessionId}&api_key=${encodeURIComponent(identity.token)}`;
      const transcodeUrl = `/Videos/${encodeURIComponent(requested.id)}/master.m3u8?MediaSourceId=${mediaSourceId}&PlaySessionId=${playSessionId}&api_key=${encodeURIComponent(identity.token)}`;
      return {
        Protocol: 'Http', Id: mediaSourceId, Path: streamUrl, Type: 'Default', Container: probe?.container || (hls ? 'hls' : 'mp4'),
        Name: source.title || `线路 ${index + 1}`, IsRemote: false, SupportsDirectPlay: true,
        SupportsDirectStream: true, SupportsTranscoding: true, SupportsProbing: true,
        DirectStreamUrl: streamUrl, TranscodingUrl: transcodeUrl,
        RunTimeTicks: probe?.runtimeTicks || catalog.userData(userId, target.id)?.runtimeTicks || undefined,
        Bitrate: probe?.bitrate, MediaStreams: probe?.streams || [],
      };
    });
    const elapsed = (from: number, to = performance.now()) => Math.round(to - from);
    request.log.info({ itemId: requested.id, sourceId: target.sourceId, ...preparation, playable: playable.length,
      waitMs: elapsed(started, preparedAt), probeWaitMs: elapsed(preparedAt), probed: !!probes }, 'PlaybackInfo timings');
    for (const [key, id] of itemGrants) if (!playbackGrants.has(id)) itemGrants.delete(key);
    itemGrants.set(`${userId}\0${requested.id}`, mediaSources[0]!.Id);
    return { MediaSources: mediaSources, PlaySessionId: playSessionId };
  }

  /** Resolve a stream grant; a MediaSourceId equal to the item id (from item MediaSources) negotiates one on demand. */
  async function streamGrant(request: FastifyRequest): Promise<PlaybackGrant> {
    if (!request.account) throw new ConfigError('Authentication required', 401);
    const params = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    let mediaSourceId = typeof query.MediaSourceId === 'string' ? query.MediaSourceId : '';
    if (!mediaSourceId || mediaSourceId === params.id) {
      const key = `${request.account.id}\0${params.id}`;
      const reusable = playbackGrants.get(itemGrants.get(key) || '');
      if (reusable && reusable.expires > Date.now()) mediaSourceId = reusable.mediaSourceId;
      else {
        mediaSourceId = (await playbackInfo(request)).MediaSources[0]!.Id;
      }
    }
    const grant = playbackGrants.get(mediaSourceId);
    if (!grant || grant.expires <= Date.now() || grant.itemId !== params.id) throw new ConfigError('Media source expired', 410);
    if (grant.userId !== request.account.id || !canAccessSource(request.account, grant.sourceId)) throw new ConfigError('Media access denied', 403);
    return grant;
  }

  function seriesEpisodes(series: CatalogItem): CatalogItem[] {
    return catalog.children(series.id).flatMap(child => child.type === 'Season'
      ? catalog.children(child.id).filter(item => item.type === 'Episode')
      : child.type === 'Episode' ? [child] : []);
  }

  /** The episode to continue: an unfinished latest one, the one after the latest finished, or the first. */
  function nextEpisode(userId: string, series: CatalogItem, firstIfUnwatched: boolean): CatalogItem | undefined {
    const episodes = seriesEpisodes(series);
    let latest = -1;
    let latestAt = 0;
    episodes.forEach((episode, index) => {
      const data = catalog.userData(userId, episode.id);
      const at = data && (data.played || data.positionTicks > 0) ? data.lastPlayedAt || data.updatedAt : 0;
      if (at > latestAt) { latest = index; latestAt = at; }
    });
    if (latest < 0) return firstIfUnwatched ? episodes[0] : undefined;
    return catalog.userData(userId, episodes[latest]!.id)?.played ? episodes[latest + 1] : episodes[latest];
  }

  function syncLegacyProgress(userId: string, item: CatalogItem, positionTicks: number, runtimeTicks: number): void {
    const series = catalog.findSeries(item) || item;
    const episode = item.type === 'Episode' ? item : catalog.children(item.id).find(child => child.type === 'Episode') || item;
    const updatedAt = Date.now();
    const mediaKey = recordKey(series.sourceId, series.link);
    const watch: WatchRecord = {
      key: episodeKey(series.sourceId, series.link, episode.upstreamId), mediaKey,
      sourceId: series.sourceId, mediaId: series.upstreamId, link: series.link, title: series.name,
      posterUrl: series.posterUrl, episodeId: episode.upstreamId, episodeTitle: episode.name,
      position: positionTicks / 10_000_000, duration: runtimeTicks / 10_000_000, updatedAt,
    };
    catalog.db.prepare(`INSERT INTO watches VALUES (?, ?, ?, ?, ?) ON CONFLICT(userId, key)
      DO UPDATE SET mediaKey=excluded.mediaKey, record=excluded.record, updatedAt=excluded.updatedAt`)
      .run(userId, watch.key, watch.mediaKey, JSON.stringify(watch), updatedAt);
    catalog.db.prepare(`INSERT INTO recent VALUES (?, ?, ?, ?) ON CONFLICT(userId, key)
      DO UPDATE SET record=excluded.record, updatedAt=excluded.updatedAt`)
      .run(userId, mediaKey, JSON.stringify(toRecent(watch)), updatedAt);
  }

  function syncLegacyFavorite(userId: string, item: CatalogItem, favorite: boolean): void {
    const series = catalog.findSeries(item) || item;
    const key = recordKey(series.sourceId, series.link);
    if (!favorite) {
      catalog.db.prepare('DELETE FROM favorites WHERE userId = ? AND key = ?').run(userId, key);
      return;
    }
    const record: FavoriteRecord = {
      key, sourceId: series.sourceId, mediaId: series.upstreamId, link: series.link,
      title: series.name, posterUrl: series.posterUrl, savedAt: Date.now(),
    };
    catalog.db.prepare(`INSERT INTO favorites VALUES (?, ?, ?, ?) ON CONFLICT(userId, key)
      DO UPDATE SET record=excluded.record, savedAt=excluded.savedAt`)
      .run(userId, key, JSON.stringify(record), record.savedAt);
  }

  function updatePlayback(request: FastifyRequest, stopped = false): object {
    if (!request.account) throw new ConfigError('Authentication required', 401);
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const itemId = typeof body.ItemId === 'string' ? body.ItemId : '';
    const item = itemId ? catalog.get(itemId) : undefined;
    if (!item || !canAccessSource(request.account, item.sourceId)) throw new ConfigError('Playback item not found', 404);
    const positionTicks = Math.max(0, Number(body.PositionTicks || 0) || 0);
    const runtimeTicks = Math.max(0, Number(body.RunTimeTicks || catalog.userData(request.account.id, item.id)?.runtimeTicks || 0) || 0);
    const completed = stopped && runtimeTicks > 0 && positionTicks >= runtimeTicks - 20_000_000;
    catalog.patchUserData(request.account.id, item.id, {
      played: completed || undefined,
      positionTicks,
      runtimeTicks,
      lastPlayedAt: Date.now(),
    });
    syncLegacyProgress(request.account.id, item, completed ? 0 : positionTicks, runtimeTicks);
    const identity = headerIdentity(request);
    const sessionId = Catalog.tokenHash(identity.token).slice(0, 32);
    if (stopped) {
      activeSessions.delete(sessionId);
    } else {
      activeSessions.set(sessionId, {
        id: sessionId, userId: request.account.id, userName: request.account.username,
        client: identity.client, deviceName: identity.device, deviceId: identity.deviceId, version: identity.version,
        lastActivityAt: Date.now(), itemId, positionTicks, paused: body.IsPaused === true,
        playSessionId: typeof body.PlaySessionId === 'string' ? body.PlaySessionId : undefined,
      });
    }
    return {};
  }

  for (const path of routePaths('/Sessions')) app.get(path, async request => {
    if (!request.account) throw new ConfigError('Authentication required', 401);
    const sessions = [...activeSessions.values()].filter(session => request.account!.role === 'admin' || session.userId === request.account!.id);
    return sessions.map(session => {
      const item = session.itemId ? catalog.get(session.itemId) : undefined;
      return {
        Id: session.id, ServerId: catalog.serverId, UserId: session.userId, UserName: session.userName,
        Client: session.client, DeviceName: session.deviceName, DeviceId: session.deviceId,
        ApplicationVersion: session.version, LastActivityDate: new Date(session.lastActivityAt).toISOString(),
        PlayState: { PositionTicks: session.positionTicks, CanSeek: true, IsPaused: session.paused, IsMuted: false },
        PlayableMediaTypes: ['Video'], SupportsRemoteControl: false,
        NowPlayingItem: item ? itemDto(catalog, accounts.getUser(session.userId) || request.account!, item) : undefined,
      };
    });
  });
  for (const path of routePaths('/Sessions/Capabilities')) app.post(path, async request => {
    if (!request.account) throw new ConfigError('Authentication required', 401);
    const identity = headerIdentity(request);
    const id = Catalog.tokenHash(identity.token).slice(0, 32);
    const current = activeSessions.get(id);
    activeSessions.set(id, {
      id, userId: request.account.id, userName: request.account.username,
      client: identity.client, deviceName: identity.device, deviceId: identity.deviceId, version: identity.version,
      lastActivityAt: Date.now(), positionTicks: current?.positionTicks || 0, paused: current?.paused || false,
      itemId: current?.itemId, playSessionId: current?.playSessionId,
    });
    return {};
  });
  for (const path of routePaths('/Sessions/Capabilities/Full')) app.post(path, async request => {
    if (!request.account) throw new ConfigError('Authentication required', 401);
    const identity = headerIdentity(request);
    const id = Catalog.tokenHash(identity.token).slice(0, 32);
    const current = activeSessions.get(id);
    activeSessions.set(id, {
      id, userId: request.account.id, userName: request.account.username,
      client: identity.client, deviceName: identity.device, deviceId: identity.deviceId, version: identity.version,
      lastActivityAt: Date.now(), positionTicks: current?.positionTicks || 0, paused: current?.paused || false,
      itemId: current?.itemId, playSessionId: current?.playSessionId,
    });
    return {};
  });
  for (const path of routePaths('/Sessions/Playing')) app.post(path, async request => updatePlayback(request));
  for (const path of routePaths('/Sessions/Playing/Progress')) app.post(path, async request => updatePlayback(request));
  for (const path of routePaths('/Sessions/Playing/Stopped')) app.post(path, async request => updatePlayback(request, true));

  const imageHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const item = catalog.get((request.params as { id: string }).id);
    if (!item || !imageTag(item) || (request.account && !canAccessSource(request.account, item.sourceId))) throw new ConfigError('Image not found', 404);
    // Without a token the tag is the capability: it is only handed out in authenticated item listings.
    if (!request.account && String((request.query as Record<string, unknown>).tag || '') !== imageTag(item)) throw new ConfigError('Image not found', 404);
    // Poster metadata rows are pruned independently of the catalog; re-register the owning title so its tag stays servable.
    const owner = catalog.findSeries(item) || item;
    const tag = imageTag({ ...item, posterUrl: posters.decorate({ sourceId: owner.sourceId, link: owner.link, title: owner.name, posterUrl: item.posterUrl }).posterUrl });
    if (!tag) throw new ConfigError('Image not found', 404);
    return posters.serve(request, reply, tag, 'private, max-age=86400', !request.account);
  };

  for (const prefix of ['', '/emby']) {
    app.get(`${prefix}/socket`, { websocket: true }, (socket, request) => {
      if (!request.account) {
        socket.close(1008, 'Authentication required');
        return;
      }
      const account = request.account;
      const identity = headerIdentity(request);
      const sessionId = Catalog.tokenHash(identity.token).slice(0, 32);
      socket.send(JSON.stringify({ MessageType: 'Sessions', Data: '[]' }));
      const keepAlive = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ MessageType: 'KeepAlive', Data: '' }));
      }, 30_000);
      keepAlive.unref();
      socket.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString()) as { MessageType?: string; Data?: Record<string, unknown> };
          if (message.MessageType !== 'ReportPlaybackProgress' || !message.Data) return;
          const itemId = typeof message.Data.ItemId === 'string' ? message.Data.ItemId : '';
          const item = itemId ? catalog.get(itemId) : undefined;
          if (!item || !canAccessSource(account, item.sourceId)) return;
          const positionTicks = Math.max(0, Number(message.Data.PositionTicks || 0) || 0);
          catalog.patchUserData(account.id, item.id, { positionTicks, lastPlayedAt: Date.now() });
          const session = activeSessions.get(sessionId);
          if (session) activeSessions.set(sessionId, { ...session, itemId, positionTicks, paused: message.Data.IsPaused === true, lastActivityAt: Date.now() });
        } catch {
          socket.close(1003, 'Invalid message');
        }
      });
      socket.on('close', () => clearInterval(keepAlive));
    });
    app.get(`${prefix}/Users`, async request => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      return [publicUser(request.account, catalog.serverId)];
    });
    app.get(`${prefix}/Library/VirtualFolders`, async request => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      const result = catalog.query(request.account, { parentId: '' });
      return result.items.map(item => ({
        Name: item.name,
        Locations: [],
        CollectionType: 'tvshows',
        LibraryOptions: { Enabled: true, EnableRealtimeMonitor: false },
        ItemId: item.id,
        PrimaryImageItemId: item.id,
        RefreshProgress: 0,
        RefreshStatus: 'Idle',
      }));
    });
    app.get(`${prefix}/Items/Counts`, async request => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      // Clients fetch this on every connect; the totals only drift with background sync, so a minute of staleness is fine.
      const key = request.account.role === 'admin' ? '*' : request.account.sourceIds.join(',');
      const cached = itemCounts.get(key);
      if (cached && cached.expires > Date.now()) return cached.value;
      const count = (type: CatalogItem['type']) => catalog.query(request.account!, { parentId: '', recursive: true, includeTypes: [type], limit: 0 }).total;
      const value = {
        MovieCount: count('Movie'),
        SeriesCount: count('Series'),
        EpisodeCount: count('Episode'),
        AlbumCount: 0,
        SongCount: 0,
        ArtistCount: 0,
        ProgramCount: 0,
        TrailerCount: 0,
      };
      for (const [stale, entry] of itemCounts) if (entry.expires <= Date.now()) itemCounts.delete(stale);
      itemCounts.set(key, { value, expires: Date.now() + 60_000 });
      return value;
    });
    app.get(`${prefix}/Items/Filters`, async () => ({
      Genres: [],
      Tags: [],
      OfficialRatings: [],
      Years: [],
    }));
    app.get(`${prefix}/Users/:id`, async request => {
      const { id } = request.params as { id: string };
      if (!request.account || request.account.id !== id) throw new ConfigError('User does not match access token', 403);
      return publicUser(request.account, catalog.serverId);
    });

    app.get(`${prefix}/Users/:userId/Views`, async request => {
      const { userId } = request.params as { userId: string };
      if (!request.account || request.account.id !== userId) throw new ConfigError('User does not match access token', 403);
      const result = catalog.query(request.account, { parentId: '' });
      return { Items: result.items.map(item => itemDto(catalog, request.account!, item)), TotalRecordCount: result.total };
    });

    const itemsHandler = async (request: FastifyRequest) => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      const query = request.query as Record<string, unknown>;
      const userId = (request.params as { userId?: string }).userId || String(query.UserId || request.account.id);
      if (userId !== request.account.id) throw new ConfigError('User does not match access token', 403);
      const result = catalog.query(request.account, queryValues(query));
      return { Items: result.items.map(item => itemDto(catalog, request.account!, item)), TotalRecordCount: result.total };
    };
    app.get(`${prefix}/Users/:userId/Items`, itemsHandler);
    app.get(`${prefix}/Items`, itemsHandler);
    app.get(`${prefix}/Items/:id`, async request => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      const { id } = request.params as { id: string };
      const item = catalog.get(id);
      if (!item || !canAccessSource(request.account, item.sourceId)) throw new ConfigError('Item not found', 404);
      if ((item.type === 'Series' || item.type === 'Movie') && item.detailAt === 0) await ensureDetail(item);
      warmPlayback(request, item);
      return itemDto(catalog, request.account, catalog.get(id) || item);
    });

    app.get(`${prefix}/Users/:userId/Items/Latest`, async request => {
      if (!request.account || request.account.id !== (request.params as { userId: string }).userId) throw new ConfigError('User does not match access token', 403);
      const query = request.query as Record<string, unknown>;
      const values = queryValues(query);
      // GroupItems (on by default) folds new episodes into their title, so list titles rather than every episode.
      const grouped = String(query.GroupItems).toLowerCase() !== 'false' && !values.includeTypes?.length;
      const result = catalog.query(request.account, { ...values, ...(grouped ? { includeTypes: ['Series', 'Movie'] } : {}), parentId: typeof query.ParentId === 'string' ? query.ParentId : undefined, recursive: true, sortBy: 'DateCreated', descending: true });
      return result.items.map(item => itemDto(catalog, request.account!, item));
    });

    app.get(`${prefix}/Users/:userId/Items/Resume`, async request => {
      if (!request.account || request.account.id !== (request.params as { userId: string }).userId) throw new ConfigError('User does not match access token', 403);
      const limit = Math.min(100, Math.max(1, Number((request.query as Record<string, unknown>).Limit || 20)));
      const items = catalog.resume(request.account, limit);
      return { Items: items.map(item => itemDto(catalog, request.account!, item)), TotalRecordCount: items.length };
    });

    app.get(`${prefix}/Users/:userId/Items/:id`, async request => {
      const { userId, id } = request.params as { userId: string; id: string };
      if (!request.account || request.account.id !== userId) throw new ConfigError('User does not match access token', 403);
      const item = catalog.get(id);
      if (!item || !canAccessSource(request.account, item.sourceId)) throw new ConfigError('Item not found', 404);
      if ((item.type === 'Series' || item.type === 'Movie') && item.detailAt === 0) await ensureDetail(item);
      warmPlayback(request, item);
      return itemDto(catalog, request.account, catalog.get(id) || item);
    });

    app.get(`${prefix}/Shows/NextUp`, async request => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      const query = request.query as Record<string, unknown>;
      if (typeof query.UserId === 'string' && query.UserId !== request.account.id) throw new ConfigError('User does not match access token', 403);
      const start = Math.max(0, Number(query.StartIndex || 0) || 0);
      const limit = Math.min(100, Math.max(0, Number(query.Limit ?? 20) || 0));
      const seriesId = typeof query.SeriesId === 'string' ? query.SeriesId : '';
      let items: CatalogItem[];
      if (seriesId) {
        const series = catalog.get(seriesId);
        if (!series || series.type !== 'Series' || !canAccessSource(request.account, series.sourceId)) throw new ConfigError('Series not found', 404);
        if (series.detailAt === 0 || !catalog.children(series.id).length) await ensureDetail(series);
        items = [nextEpisode(request.account.id, series, true)].flatMap(item => item ? [item] : []);
        warmPlayback(request, items[0]);
      } else {
        const seen = new Set<string>();
        items = [];
        const recent = catalog.db.prepare(`SELECT itemId FROM user_item_data WHERE userId = ? AND (played = 1 OR positionTicks > 0)
          ORDER BY COALESCE(lastPlayedAt, updatedAt) DESC LIMIT 500`).all(request.account.id) as { itemId: string }[];
        for (const { itemId } of recent) {
          if (items.length >= start + limit) break;
          const item = catalog.get(itemId);
          const series = item && catalog.findSeries(item);
          if (!series || series.type !== 'Series' || seen.has(series.id) || !canAccessSource(request.account, series.sourceId)) continue;
          seen.add(series.id);
          const next = nextEpisode(request.account.id, series, false);
          if (next) items.push(next);
        }
      }
      return { Items: items.slice(start, start + limit).map(item => itemDto(catalog, request.account!, item)), TotalRecordCount: items.length };
    });

    for (const path of ['Items', 'Shows', 'Movies']) app.get(`${prefix}/${path}/:id/Similar`, async request => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      return { Items: [], TotalRecordCount: 0 };
    });

    app.get(`${prefix}/Shows/:id/Seasons`, async request => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      const series = catalog.get((request.params as { id: string }).id);
      if (!series || series.type !== 'Series' || !canAccessSource(request.account, series.sourceId)) throw new ConfigError('Series not found', 404);
      if (series.detailAt === 0 || !catalog.children(series.id).length) await ensureDetail(series);
      const items = catalog.children(series.id).filter(item => item.type === 'Season');
      return { Items: items.map(item => itemDto(catalog, request.account!, item)), TotalRecordCount: items.length };
    });

    app.get(`${prefix}/Shows/:id/Episodes`, async request => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      const series = catalog.get((request.params as { id: string }).id);
      if (!series || series.type !== 'Series' || !canAccessSource(request.account, series.sourceId)) throw new ConfigError('Series not found', 404);
      if (series.detailAt === 0 || !catalog.children(series.id).length) await ensureDetail(series);
      const seasonId = String((request.query as Record<string, unknown>).SeasonId || '');
      const seasons = catalog.children(series.id).filter(item => item.type === 'Season' && (!seasonId || item.id === seasonId));
      const items = seasons.flatMap(season => catalog.children(season.id).filter(item => item.type === 'Episode'));
      return { Items: items.map(item => itemDto(catalog, request.account!, item)), TotalRecordCount: items.length };
    });

    app.get(`${prefix}/Items/:id/Images/:type`, imageHandler);

    app.post(`${prefix}/Users/:userId/FavoriteItems/:id`, async request => {
      const { userId, id } = request.params as { userId: string; id: string };
      if (!request.account || request.account.id !== userId) throw new ConfigError('User does not match access token', 403);
      const item = catalog.get(id);
      if (!item || !canAccessSource(request.account, item.sourceId)) throw new ConfigError('Item not found', 404);
      const data = catalog.patchUserData(userId, id, { favorite: true });
      syncLegacyFavorite(userId, item, true);
      return { ...itemDto(catalog, request.account, item), UserData: userDataDto(id, data) };
    });
    app.delete(`${prefix}/Users/:userId/FavoriteItems/:id`, async request => {
      const { userId, id } = request.params as { userId: string; id: string };
      if (!request.account || request.account.id !== userId) throw new ConfigError('User does not match access token', 403);
      const item = catalog.get(id);
      if (!item || !canAccessSource(request.account, item.sourceId)) throw new ConfigError('Item not found', 404);
      const data = catalog.patchUserData(userId, id, { favorite: false });
      syncLegacyFavorite(userId, item, false);
      return { ...itemDto(catalog, request.account, item), UserData: userDataDto(id, data) };
    });
    app.post(`${prefix}/Users/:userId/PlayedItems/:id`, async request => {
      const { userId, id } = request.params as { userId: string; id: string };
      if (!request.account || request.account.id !== userId) throw new ConfigError('User does not match access token', 403);
      const item = catalog.get(id);
      if (!item || !canAccessSource(request.account, item.sourceId)) throw new ConfigError('Item not found', 404);
      const data = catalog.patchUserData(userId, id, { played: true, lastPlayedAt: Date.now() });
      syncLegacyProgress(userId, item, 0, data.runtimeTicks);
      return userDataDto(id, data);
    });
    app.delete(`${prefix}/Users/:userId/PlayedItems/:id`, async request => {
      const { userId, id } = request.params as { userId: string; id: string };
      if (!request.account || request.account.id !== userId) throw new ConfigError('User does not match access token', 403);
      const item = catalog.get(id);
      if (!item || !canAccessSource(request.account, item.sourceId)) throw new ConfigError('Item not found', 404);
      const data = catalog.patchUserData(userId, id, { played: false, positionTicks: 0 });
      syncLegacyProgress(userId, item, 0, data.runtimeTicks);
      return userDataDto(id, data);
    });

    app.get(`${prefix}/Items/:id/PlaybackInfo`, async request => playbackInfo(request));
    app.post(`${prefix}/Items/:id/PlaybackInfo`, async request => playbackInfo(request));
    const streamHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      const grant = await streamGrant(request);
      const token = headerIdentity(request).token;
      const separator = grant.path.includes('?') ? '&' : '?';
      return reply.code(302).header('Location', `${grant.path}${token ? `${separator}api_key=${encodeURIComponent(token)}` : ''}`).send();
    };
    app.get(`${prefix}/Videos/:id/stream`, streamHandler);
    app.get(`${prefix}/Videos/:id/stream.:container`, streamHandler);

    app.get(`${prefix}/Videos/:id/master.m3u8`, async (request, reply) => {
      const grant = await streamGrant(request);
      const { mediaSourceId } = grant;
      const query = request.query as Record<string, unknown>;
      const accessToken = headerIdentity(request).token;
      const startTimeTicks = Math.max(0, Number(query.StartTimeTicks || 0) || 0);
      const input: TranscodeInput = { id: mediaSourceId, userId: grant.userId, sourceId: grant.sourceId, mediaPath: grant.path, accessToken };
      const playlist = (await transcoder.playlist(input, startTimeTicks)).toString('utf8');
      const sessionId = transcoder.sessionId(mediaSourceId, startTimeTicks);
      const rewritten = playlist.split(/\r?\n/).map(line => {
        if (!line || line.startsWith('#')) return line;
        return `transcode/${encodeURIComponent(sessionId)}/${encodeURIComponent(line)}?MediaSourceId=${mediaSourceId}&api_key=${encodeURIComponent(accessToken)}`;
      }).join('\n');
      return reply.type('application/vnd.apple.mpegurl').send(rewritten);
    });
    app.get(`${prefix}/Videos/:id/transcode/:sessionId/:file`, async (request, reply) => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      const params = request.params as { id: string; sessionId: string; file: string };
      const query = request.query as Record<string, unknown>;
      const mediaSourceId = typeof query.MediaSourceId === 'string' ? query.MediaSourceId : '';
      const grant = playbackGrants.get(mediaSourceId);
      if (!grant || grant.expires <= Date.now() || grant.itemId !== params.id) throw new ConfigError('Media source expired', 410);
      if (grant.userId !== request.account.id || !canAccessSource(request.account, grant.sourceId)) throw new ConfigError('Media access denied', 403);
      const input: TranscodeInput = { id: mediaSourceId, userId: grant.userId, sourceId: grant.sourceId, mediaPath: grant.path, accessToken: headerIdentity(request).token };
      const bytes = await transcoder.segment(input, params.sessionId, params.file);
      return reply.type('video/mp2t').send(bytes);
    });

    app.post(`${prefix}/Users/:userId/Items/:itemId/UserData`, async request => {
      const params = request.params as { userId: string; itemId: string };
      if (!request.account || request.account.id !== params.userId) throw new ConfigError('User does not match access token', 403);
      const item = catalog.get(params.itemId);
      if (!item || !canAccessSource(request.account, item.sourceId)) throw new ConfigError('Item not found', 404);
      const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
      const data = catalog.patchUserData(params.userId, params.itemId, {
        favorite: typeof body.IsFavorite === 'boolean' ? body.IsFavorite : undefined,
        played: typeof body.Played === 'boolean' ? body.Played : undefined,
        positionTicks: typeof body.PlaybackPositionTicks === 'number' ? body.PlaybackPositionTicks : undefined,
        lastPlayedAt: body.LastPlayedDate ? Date.parse(String(body.LastPlayedDate)) || Date.now() : undefined,
      });
      if (typeof body.IsFavorite === 'boolean') syncLegacyFavorite(params.userId, item, body.IsFavorite);
      if (typeof body.PlaybackPositionTicks === 'number' || typeof body.Played === 'boolean') {
        syncLegacyProgress(params.userId, item, data.positionTicks, data.runtimeTicks);
      }
      return userDataDto(params.itemId, data);
    });

    app.get(`${prefix}/Items/:id/Images/:type/:index`, imageHandler);

    app.get(`${prefix}/Search/Hints`, async request => {
      if (!request.account) throw new ConfigError('Authentication required', 401);
      const query = request.query as Record<string, unknown>;
      const search = typeof query.SearchTerm === 'string' ? query.SearchTerm.trim().slice(0, 200) : '';
      // Episode rows are mostly "第 N 集" (or repeat their movie's title), so hints search titles unless asked otherwise.
      const { includeTypes } = queryValues(query);
      const result = catalog.query(request.account, { parentId: '', recursive: true, search, includeTypes: includeTypes?.length ? includeTypes : ['Series', 'Movie'], limit: Math.min(100, Number(query.Limit || 20) || 20) });
      return {
        SearchHints: result.items.map(item => ({
          ItemId: item.id, Id: item.id, Name: item.name, Type: item.type, MediaType: item.type === 'Episode' || item.type === 'Movie' ? 'Video' : undefined,
          PrimaryImageTag: imageTag(item), ProductionYear: undefined,
        })),
        TotalRecordCount: result.total,
      };
    });

    app.get(`${prefix}/DisplayPreferences/:id`, async request => {
      const params = request.params as { id: string };
      const query = request.query as Record<string, unknown>;
      return {
        Id: params.id, ViewType: 'Poster', SortBy: 'SortName', SortOrder: 'Ascending',
        RememberIndexing: false, IndexBy: 'None', ShowBackdrop: true, ShowSidebar: true,
        Client: String(query.Client || ''),
      };
    });
    app.get(`${prefix}/UserSettings/:userId`, async request => {
      const params = request.params as { userId: string };
      if (!request.account || request.account.id !== params.userId) throw new ConfigError('User does not match access token', 403);
      return { UserId: params.userId, Configuration: publicUser(request.account, catalog.serverId).Configuration };
    });
  }

  app.get('/api/admin/emby/status', async request => {
    if (request.account?.role !== 'admin') throw new ConfigError('Administrator access required', 403);
    return {
      sessions: [...activeSessions.values()],
      transcodes: transcoder.status(),
      tokens: catalog.db.prepare(`SELECT emby_tokens.userId, users.username, emby_tokens.deviceId, emby_tokens.client,
        emby_tokens.deviceName, emby_tokens.version, emby_tokens.createdAt, emby_tokens.lastUsedAt
        FROM emby_tokens JOIN users ON users.id = emby_tokens.userId ORDER BY emby_tokens.lastUsedAt DESC`).all(),
    };
  });

  async function ensureDetail(item: CatalogItem): Promise<Detail> {
    return loadDetail(item.sourceId, item.link);
  }
}
