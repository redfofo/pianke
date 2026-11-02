export interface PageInfo { hasMore: boolean; total?: number; pageCount?: number; }

function count(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Upstreams disagree on paging fields; prefer explicit flags, then pageCount, and only then guess from a non-empty page. */
export function pageInfo(data: Record<string, unknown> | undefined, page: number, itemCount: number): PageInfo {
  const total = count(data?.total);
  const pageCount = count(data?.pageCount);
  const flag = typeof data?.hasMore === 'boolean' ? data.hasMore : typeof data?.has_more === 'boolean' ? data.has_more : undefined;
  const hasMore = flag ?? (itemCount > 0 && (pageCount === undefined || page < pageCount));
  return { hasMore, ...(total === undefined ? {} : { total }), ...(pageCount === undefined ? {} : { pageCount }) };
}
