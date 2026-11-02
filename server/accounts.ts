import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConfigError } from './config.js';
import { isKnownSource, knownSourceIds } from './source-registry.js';

export interface User { id: string; username: string; role: 'admin' | 'user'; createdAt: number; sourceIds: string[]; }
interface UserRow extends Omit<User, 'sourceIds'> { sourceIds: string; salt: string; passwordHash: string; }
declare module 'fastify' { interface FastifyRequest { account: User | null; } }
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const cookieName = 'short_session';
const usernamePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{2,31}$/;
function passwordHash(password: string, salt: string): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result));
  return promise;
}
function publicUser(row: UserRow): User { return { id: row.id, username: row.username, role: row.role, createdAt: row.createdAt, sourceIds: row.role === 'admin' ? knownSourceIds() : JSON.parse(row.sourceIds) as string[] }; }
function selectedSources(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !isKnownSource(id))) throw new ConfigError('视频源权限需为已知视频源 ID 数组', 400);
  return [...new Set(value as string[])];
}
export function canAccessSource(user: User | null, sourceId: string): boolean {
  return !!user && isKnownSource(sourceId) && (user.role === 'admin' || user.sourceIds.includes(sourceId));
}
export function requireSourceAccess(user: User | null, sourceId: string): void {
  if (!canAccessSource(user, sourceId)) throw new ConfigError('无权访问此视频源', 403);
}
function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function sessionToken(request: FastifyRequest): string | undefined {
  const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
function setCookie(request: FastifyRequest, reply: FastifyReply, token: string, maxAge: number): void {
  const secure = request.protocol === 'https' || process.env.SESSION_COOKIE_SECURE === 'true';
  reply.header('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
function credentials(value: unknown): { username: string; password: string } {
  if (!value || typeof value !== 'object') throw new ConfigError('账号或密码格式无效', 400);
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== 'string' || !usernamePattern.test(username.trim()) || typeof password !== 'string' || password.length < 10 || password.length > 128) throw new ConfigError('账号需为 3–32 位字母、数字、下划线、点或连字符；密码需为 10–128 位', 400);
  return { username: username.trim(), password };
}

export class AccountDatabase {
  readonly db: DatabaseSync;
  constructor(readonly directory = resolve(process.env.DATA_DIR || './data')) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'accounts.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), createdAt INTEGER NOT NULL,
        salt TEXT NOT NULL, passwordHash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expiresAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expiresAt);
      CREATE TABLE IF NOT EXISTS watches (
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL, mediaKey TEXT NOT NULL, record TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(userId, key)
      );
      CREATE INDEX IF NOT EXISTS watches_media ON watches(userId, mediaKey);
      CREATE TABLE IF NOT EXISTS recent (
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL, record TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(userId, key)
      );
      CREATE INDEX IF NOT EXISTS recent_updated ON recent(userId, updatedAt DESC);
      CREATE TABLE IF NOT EXISTS favorites (
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL, record TEXT NOT NULL, savedAt INTEGER NOT NULL,
        PRIMARY KEY(userId, key)
      );
      CREATE INDEX IF NOT EXISTS favorites_saved ON favorites(userId, savedAt DESC);
    `);
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(users)').all();
      if (!columns.some(column => column.name === 'sourceIds')) {
        this.db.exec("ALTER TABLE users ADD COLUMN sourceIds TEXT NOT NULL DEFAULT '[]'");
        this.db.prepare('UPDATE users SET sourceIds = ?').run(JSON.stringify(knownSourceIds()));
      }
    });
  }
  async initialize(): Promise<void> {
    if (this.db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()) return;
    if (!process.env.ADMIN_PASSWORD) throw new Error('首次启动必须设置 ADMIN_PASSWORD（10–128 位），用于创建管理员账号');
    const input = credentials({ username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD });
    await this.createUser(input.username, input.password, 'admin');
  }
  getUser(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
    return row ? publicUser(row) : undefined;
  }
  async authenticateCredentials(username: string, password: string): Promise<User | undefined> {
    const normalized = username.trim();
    if (!usernamePattern.test(normalized) || password.length > 128) return undefined;
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(normalized) as unknown as UserRow | undefined;
    const salt = row?.salt || randomBytes(32).toString('hex');
    const hash = await passwordHash(password, salt);
    if (!row || !timingSafeEqual(hash, Buffer.from(row.passwordHash, 'hex'))) return undefined;
    return publicUser(row);
  }
  async createUser(username: string, password: string, role: User['role'] = 'user', sources: unknown = knownSourceIds()): Promise<User> {
    const selected = selectedSources(sources);
    const salt = randomBytes(32).toString('hex');
    const hash = await passwordHash(password, salt);
    const user: User = { id: randomUUID(), username, role, createdAt: Date.now(), sourceIds: role === 'admin' ? knownSourceIds() : selected };
    try { this.db.prepare('INSERT INTO users (id, username, role, createdAt, salt, passwordHash, sourceIds) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.id, user.username, user.role, user.createdAt, salt, hash.toString('hex'), JSON.stringify(user.sourceIds)); }
    catch (error) {
      if (this.db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw new ConfigError('账号已存在', 409);
      throw error;
    }
    return user;
  }
  session(request: FastifyRequest): User | null {
    const token = sessionToken(request);
    if (!token) return null;
    const row = this.db.prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.userId WHERE tokenHash = ? AND expiresAt > ?').get(tokenHash(token), Date.now()) as unknown as UserRow | undefined;
    return row ? publicUser(row) : null;
  }
  embySession(request: FastifyRequest): User | null {
    const authorization = String(request.headers['x-emby-authorization'] || request.headers.authorization || '');
    const headerToken = authorization.match(/Token="([^"]+)"/i)?.[1];
    const query = request.query && typeof request.query === 'object' ? request.query as Record<string, unknown> : {};
    const token = String(request.headers['x-emby-token'] || headerToken || queryToken(query) || '');
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='emby_tokens'").get();
    if (!table) return null;
    const row = this.db.prepare('SELECT users.* FROM emby_tokens JOIN users ON users.id = emby_tokens.userId WHERE tokenHash = ?').get(tokenHash(token)) as unknown as UserRow | undefined;
    return row ? publicUser(row) : null;
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

/** Emby clients pass the token in the query as api_key, ApiKey or X-Emby-Token, in any letter case. */
export function queryToken(query: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && ['api_key', 'apikey', 'x-emby-token'].includes(key.toLowerCase())) return value;
  }
  return '';
}

export function registerAccountRoutes(app: FastifyInstance, accounts: AccountDatabase): void {
  app.decorateRequest('account', null);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions.url || request.url.split('?')[0]!;
    if (!(path === '/api' || path.startsWith('/api/') || path.startsWith('/server/'))) return;
    reply.header('Cache-Control', 'private, no-store');
    request.account = accounts.session(request) || accounts.embySession(request);
    if (['/api/health', '/api/auth/login', '/api/auth/me'].includes(path)) return;
    if (!request.account) return reply.code(401).send({ error: '请先登录' });
    if ((path === '/api/config' || path.startsWith('/api/admin/')) && request.account.role !== 'admin') return reply.code(403).send({ error: '仅管理员可执行此操作' });
    if ((path === '/api/library' || path.startsWith('/api/library/')) && request.headers['x-account-id'] !== request.account.id) return reply.code(409).send({ error: '登录账号已更改，请重新登录' });
    if (path.startsWith('/api/sources/')) {
      const { id } = request.params as { id: string };
      requireSourceAccess(request.account, id);
    }
  });
  const attempts = new Map<string, { count: number; expires: number }>();
  const windowMs = 15 * 60 * 1000;
  let pending = 0;
  const dummySalt = randomBytes(32).toString('hex');
  app.get('/api/auth/me', async request => ({ user: request.account }));
  app.post('/api/auth/login', async (request, reply) => {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.expires <= now) attempts.delete(key);
    const previous = attempts.get(request.ip);
    if (pending >= 4 || (previous && previous.count >= 10) || (!previous && attempts.size >= 10000)) return reply.header('Retry-After', '900').code(429).send({ error: '登录尝试过于频繁，请稍后重试' });
    attempts.set(request.ip, { count: (previous?.count || 0) + 1, expires: previous?.expires || now + windowMs });
    const body = request.body as Record<string, unknown> | null;
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' && body.password.length <= 128 ? body.password : '';
    const row = usernamePattern.test(username) ? accounts.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as UserRow | undefined : undefined;
    pending++;
    let hash: Buffer;
    try { hash = await passwordHash(password, row?.salt || dummySalt); }
    finally { pending--; }
    if (!row || !timingSafeEqual(hash, Buffer.from(row.passwordHash, 'hex'))) return reply.code(401).send({ error: '账号或密码错误' });
    attempts.delete(request.ip);
    const token = randomBytes(32).toString('base64url');
    accounts.transaction(() => {
      accounts.db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(now);
      const oldToken = sessionToken(request);
      if (oldToken) accounts.db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(tokenHash(oldToken));
      accounts.db.prepare('DELETE FROM sessions WHERE userId = ? AND tokenHash NOT IN (SELECT tokenHash FROM sessions WHERE userId = ? ORDER BY expiresAt DESC LIMIT 19)').run(row.id, row.id);
      accounts.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), row.id, now + sessionLifetime);
    });
    setCookie(request, reply, token, sessionLifetime / 1000);
    return { user: publicUser(row) };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = sessionToken(request);
    if (token) accounts.db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(tokenHash(token));
    setCookie(request, reply, '', 0);
    return { ok: true };
  });
  app.get('/api/admin/users', async () => ({ users: (accounts.db.prepare('SELECT * FROM users ORDER BY createdAt, id').all() as unknown as UserRow[]).map(publicUser) }));
  app.post('/api/admin/users', async request => {
    const input = credentials(request.body);
    const sources = (request.body as Record<string, unknown>).sourceIds;
    return { user: await accounts.createUser(input.username, input.password, 'user', sources) };
  });
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/sources', async request => {
    const row = accounts.db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id) as unknown as UserRow | undefined;
    if (!row) throw new ConfigError('账号不存在', 404);
    if (row.role === 'admin') throw new ConfigError('管理员始终可访问全部视频源', 403);
    const sources = selectedSources((request.body as Record<string, unknown> | null)?.sourceIds);
    accounts.db.prepare('UPDATE users SET sourceIds = ? WHERE id = ?').run(JSON.stringify(sources), row.id);
    return { user: publicUser({ ...row, sourceIds: JSON.stringify(sources) }) };
  });
}
