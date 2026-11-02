import type { FastifyBaseLogger } from 'fastify';
import type { Detail, MediaItem } from '../src/types.js';
import { knownSourceIds } from './source-registry.js';
import { browseSource, listSources } from './providers.js';
import type { Catalog } from './catalog.js';

export class CatalogSynchronizer {
  private timer: NodeJS.Timeout | undefined;
  private initialTimer: NodeJS.Timeout | undefined;
  private readonly running = new Set<string>();
  private readonly detailMaxAge: number;
  private readonly detailConcurrency: number;
  private closed = false;

  constructor(
    private readonly catalog: Catalog,
    private readonly present: <T extends MediaItem>(item: T) => T,
    private readonly loadDetail: (sourceId: string, link: string) => Promise<Detail>,
    private readonly prefetchPoster: (posterUrl: string) => Promise<void>,
    private readonly logger: FastifyBaseLogger,
  ) {
    const configuredDays = Number(process.env.CATALOG_DETAIL_CACHE_DAYS || 7);
    this.detailMaxAge = (Number.isFinite(configuredDays) ? Math.max(1, configuredDays) : 7) * 24 * 60 * 60 * 1000;
    const configuredConcurrency = Number(process.env.CATALOG_DETAIL_CONCURRENCY || 3);
    this.detailConcurrency = Number.isSafeInteger(configuredConcurrency) ? Math.min(8, Math.max(1, configuredConcurrency)) : 3;
  }

  start(): void {
    if (this.timer || this.closed) return;
    const configured = Number(process.env.CATALOG_SYNC_INTERVAL_MINUTES || 360);
    const interval = Number.isFinite(configured) ? Math.max(15, configured) * 60_000 : 360 * 60_000;
    this.timer = setInterval(() => void this.scanAll(), interval);
    this.timer.unref();
    this.initialTimer = setTimeout(() => void this.scanAll(), 2_000);
    this.initialTimer.unref();
  }

  async scanAll(sourceIds?: readonly string[]): Promise<void> {
    if (sourceIds?.length) {
      for (const sourceId of sourceIds) await this.scanSource(sourceId);
      return;
    }
    try {
      const discovered = await listSources(() => true);
      for (const source of discovered) if (!source.error) await this.scanSource(source.id);
    } catch (error) {
      this.logger.warn({ err: error }, 'Catalog source discovery failed');
      const message = error instanceof Error ? error.message : String(error);
      for (const sourceId of knownSourceIds()) this.catalog.setSync(sourceId, 'error', { completedAt: Date.now(), error: message.slice(0, 1000) });
    }
  }
  private async cacheItems(items: MediaItem[], seen: Set<string>): Promise<void> {
    const pending = items.filter(item => {
      const key = JSON.stringify([item.sourceId, item.link]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    let next = 0;
    const worker = async () => {
      while (!this.closed) {
        const item = pending[next++];
        if (!item) return;
        const cachePoster = (posterUrl: string) => this.prefetchPoster(posterUrl).catch(error => {
          this.logger.debug({ err: error, sourceId: item.sourceId, link: item.link }, 'Catalog poster caching failed');
        });
        const initialPoster = cachePoster(item.posterUrl);
        let detail: Detail | undefined;
        const indexed = this.catalog.findMedia(item.sourceId, item.link);
        if (indexed && this.catalog.needsDetail(indexed, this.detailMaxAge)) {
          try {
            detail = await this.loadDetail(item.sourceId, item.link);
          } catch (error) {
            this.logger.warn({ err: error, sourceId: item.sourceId, link: item.link }, 'Catalog detail caching failed');
          }
        }
        await initialPoster;
        if (detail && detail.posterUrl !== item.posterUrl) await cachePoster(detail.posterUrl);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.detailConcurrency, pending.length) }, worker));
  }

  async scanSource(sourceId: string): Promise<void> {
    if (this.closed || this.running.has(sourceId)) return;
    this.running.add(sourceId);
    const startedAt = Date.now();
    this.catalog.setSync(sourceId, 'scanning', { startedAt, scannedItems: 0, error: '' });
    let scannedItems = 0;
    const seen = new Set<string>();
    try {
      const source = (await listSources([sourceId])).find(entry => entry.id === sourceId);
      if (!source || source.error) throw new Error(source?.error || '来源当前不可用');
      const modules = source.modules.filter(module => !/history|search/i.test(module.id));
      const configured = Number(process.env.CATALOG_SYNC_MAX_PAGES || 100);
      const maxPages = Number.isSafeInteger(configured) && configured > 0 ? configured : 100;
      for (const module of modules) {
        for (let page = 1; page <= maxPages; page++) {
          if (this.closed) return;
          const result = await browseSource(sourceId, module.id, { page: String(page) }, true);
          const items = result.items.map(this.present);
          this.catalog.ingestBrowse({ ...result, items });
          await this.cacheItems(items, seen);
          scannedItems += items.length;
          this.catalog.setSync(sourceId, 'scanning', { scannedItems });
          if (!result.hasMore || !items.length) break;
        }
      }
      this.catalog.setSync(sourceId, 'idle', { scannedItems, completedAt: Date.now(), error: '' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.catalog.setSync(sourceId, 'error', { scannedItems, completedAt: Date.now(), error: message.slice(0, 1000) });
      this.logger.warn({ err: error, sourceId }, 'Catalog synchronization failed');
    } finally {
      this.running.delete(sourceId);
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.initialTimer);
    this.timer = undefined;
    this.initialTimer = undefined;
  }
}
