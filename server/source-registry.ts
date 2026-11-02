import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sourceCatalog } from '../src/source-catalog.js';

/**
 * Every source this server has ever seen: the built-in catalog plus components discovered on the upstream.
 * Sources are never forgotten, so permissions, history and catalog rows of a temporarily removed component survive;
 * whether a source is usable right now is decided by the upstream component list, not by this registry.
 */
export interface SourceEntry { id: string; title: string; }
export const sourceIdPattern = '^[a-z0-9][a-z0-9_-]{0,31}$';
const idPattern = new RegExp(sourceIdPattern);
const registryPath = join(resolve(process.env.DATA_DIR || './data'), 'sources.json');
const entries = new Map<string, string>(sourceCatalog.map(source => [source.id, source.title]));
const listeners = new Set<(added: SourceEntry[]) => void>();

function normalizedTitle(id: string, value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : id;
}
try {
  const saved: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
  const rows = saved && typeof saved === 'object' && 'sources' in saved && Array.isArray(saved.sources) ? saved.sources as unknown[] : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { id, title } = row as Record<string, unknown>;
    if (typeof id === 'string' && idPattern.test(id) && !entries.has(id)) entries.set(id, normalizedTitle(id, title));
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`忽略无法读取的来源注册表 ${registryPath}: ${(error as Error).message}`);
}

function persist(): void {
  const temporary = `${registryPath}.${randomUUID()}.tmp`;
  try {
    mkdirSync(resolve(registryPath, '..'), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ sources: sourceEntries() }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, registryPath);
  } catch (error) {
    // Still usable for this process; the upstream list re-registers the sources after a restart.
    console.warn(`来源注册表保存失败: ${(error as Error).message}`);
  }
}

export function isKnownSource(id: string): boolean { return entries.has(id); }
export function knownSourceIds(): string[] { return [...entries.keys()]; }
export function sourceTitle(id: string): string { return entries.get(id) ?? id; }
export function sourceEntries(): SourceEntry[] { return [...entries].map(([id, title]) => ({ id, title })); }
export function isValidSourceId(id: unknown): id is string { return typeof id === 'string' && idPattern.test(id); }

/** Adds upstream components not seen before and refreshes titles of discovered ones; returns the new sources. */
export function registerSources(discovered: readonly { id: string; title?: unknown }[]): SourceEntry[] {
  const added: SourceEntry[] = [];
  let changed = false;
  for (const { id, title } of discovered) {
    if (!isValidSourceId(id)) continue;
    const previous = entries.get(id);
    // Built-in titles are curated; upstream titles only name sources this project does not know about.
    const next = sourceCatalog.some(source => source.id === id) ? previous! : normalizedTitle(id, title === undefined ? previous : title);
    if (previous === next) continue;
    entries.set(id, next);
    changed = true;
    if (previous === undefined) added.push({ id, title: next });
  }
  if (changed) persist();
  if (added.length) for (const listener of listeners) listener(added);
  return added;
}

export function onSourcesAdded(listener: (added: SourceEntry[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
