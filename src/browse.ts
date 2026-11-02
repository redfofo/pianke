import type { Parameter, Source, SourceModule } from './types';

const HISTORY_MODULE = /history|历史|记录|继续观看/i;

/** Requested module, else a preferred default, else the first non-history module. */
export function resolveModule(source: Source | undefined, requested: unknown): SourceModule | undefined {
  const modules = source?.modules || [];
  return (
    modules.find((item) => item.id === requested) ||
    modules.find((item) => item.id === 'hongguo-short') ||
    modules.find((item) => !HISTORY_MODULE.test(item.title + item.id)) ||
    modules[0]
  );
}

/** Module parameters, taking values from `p_<name>` query keys before the module defaults. */
export function resolveParams(module: SourceModule | undefined, query: URLSearchParams): Record<string, string> {
  return Object.fromEntries(
    (module?.params || [])
      .filter((param) => param.name !== 'page' && param.type !== 'page')
      .map((param) => [
        param.name,
        query.get(`p_${param.name}`) ?? param.value ?? param.defaultValue ?? param.enumOptions?.[0]?.value ?? '',
      ]),
  );
}

export function editableFilters(module: SourceModule | undefined, params: Record<string, string>): Parameter[] {
  return module?.params.filter((param) => param.type !== 'constant' && Object.hasOwn(params, param.name)) || [];
}

/**
 * Some upstreams report pageCount = page + 1 as "another page exists"; only trust it when it
 * cannot be that placeholder.
 */
export function knownPages(page: number, pageCount?: number, total?: number): number | undefined {
  if (pageCount === undefined) return undefined;
  if (total === undefined && pageCount === page + 1) return undefined;
  return Math.min(pageCount, 10000);
}

export function parsePage(value: unknown): number {
  return Math.max(1, Math.floor(Number(value) || 1));
}

export function formatPosition(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

/** True when a saved position is far enough from the end to be worth resuming. */
export function isUnfinished(position: number, duration: number): boolean {
  return position > 0 && (duration <= 0 || position < duration - 2);
}

/** Runs at most `limit` tasks at once; used to keep cross-source search gentle on the upstream. */
export function createLimiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= limit) return;
    const run = queue.shift();
    if (run) run();
  };
  return function limited<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}
