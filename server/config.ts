import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ConfigError extends Error {
  constructor(message: string, public readonly statusCode: number) { super(message); }
}

export interface BackendConfig { backendUrl: string; persisted: boolean; }

export function normalizeBackendUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError('请输入上游服务地址', 400);
  const input = value.trim();
  let url: URL;
  try { url = new URL(input); }
  catch { throw new ConfigError('上游地址必须是有效的 HTTP(S) 服务根地址', 400); }
  if (!/^https?:\/\/[^/?#\\\s@]+\/?$/i.test(input) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('上游地址必须是 HTTP(S) 服务根地址，不能包含账号密码、路径、查询参数或片段', 400);
  }
  return url.origin;
}

const dataDir = resolve(process.env.DATA_DIR || './data');
const configPath = join(dataDir, 'config.json');
function initialConfig(): BackendConfig {
  let text: string;
  try { text = readFileSync(configPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const env = process.env.CAPY_BACKEND_URL?.trim();
      try { return { backendUrl: env ? normalizeBackendUrl(env) : '', persisted: false }; }
      catch (invalid) { throw new Error(`CAPY_BACKEND_URL 无效：${(invalid as Error).message}`); }
    }
    throw new Error(`无法读取上游配置 ${configPath}`, { cause: error });
  }
  try {
    const saved: unknown = JSON.parse(text);
    if (!saved || typeof saved !== 'object' || !('backendUrl' in saved)) throw new Error('缺少 backendUrl');
    return { backendUrl: normalizeBackendUrl(saved.backendUrl), persisted: true };
  } catch (error) { throw new Error(`上游配置文件 ${configPath} 无效：${(error as Error).message}`, { cause: error }); }
}

const initial = initialConfig();
export let backendUrl = initial.backendUrl;
let persisted = initial.persisted;
let activeSources = 0;
let saving = false;

export function getConfig(): BackendConfig { return { backendUrl, persisted }; }
export function requireBackend(): void {
  if (!backendUrl) throw new ConfigError('未配置上游服务，请前往设置填写并保存上游地址', 503);
}
// Track handler completion, not socket closure: aborted clients may leave work running.
export async function withSourceOperation<T>(operation: () => T | PromiseLike<T>): Promise<T> {
  if (saving) throw new ConfigError('正在保存上游配置，请稍后重试', 409);
  requireBackend();
  activeSources++;
  try { return await operation(); }
  finally { activeSources--; }
}

export async function saveBackendUrl(value: unknown, onSaved: () => void): Promise<BackendConfig> {
  const next = normalizeBackendUrl(value);
  if (saving || activeSources) throw new ConfigError('内容源正在使用或配置正在保存，请稍后重试', 409);
  saving = true;
  const temporary = join(dataDir, `.config-${randomUUID()}.tmp`);
  try {
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(temporary, JSON.stringify({ backendUrl: next }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, configPath);
    } catch (error) {
      throw new ConfigError(`上游配置保存失败，当前配置未更改：${(error as Error).message}`, 500);
    }
    backendUrl = next;
    persisted = true;
    onSaved();
    return getConfig();
  } finally {
    await unlink(temporary).catch(() => {});
    saving = false;
  }
}
