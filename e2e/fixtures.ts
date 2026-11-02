import { test as base, type Page } from '@playwright/test';
import type { BrowseResult, Detail, Source } from '../src/types';

export const sources: Source[] = [
  {
    id: 'alpha',
    title: '甲来源',
    description: '测试来源甲',
    version: '1.0',
    capabilities: ['browser', 'search', 'detail', 'playback'],
    icon: '',
    modules: [
      { id: 'hot', title: '热门', params: [] },
      { id: 'new', title: '最新', params: [] },
    ],
  },
  {
    id: 'beta',
    title: '乙来源',
    description: '测试来源乙',
    version: '1.0',
    capabilities: ['browser', 'search', 'detail', 'playback'],
    icon: '',
    modules: [{ id: 'all', title: '全部', params: [] }],
  },
];

export function listPage(sourceId: string, page: number, prefix = '剧'): BrowseResult {
  return {
    page,
    hasMore: page < 3,
    total: 72,
    pageCount: 3,
    items: Array.from({ length: 24 }, (_, index) => {
      const id = `${sourceId}-${page}-${index}`;
      return { id, sourceId, title: `${prefix}${page}-${index}`, posterUrl: '', link: `/drama/${id}` };
    }),
  };
}

export function detailFor(sourceId: string, link: string): Detail {
  const episodeItems = Array.from({ length: 12 }, (_, index) => ({
    id: `ep${index + 1}`,
    title: `第${index + 1}集`,
    videoUrl: '',
    link,
  }));
  return {
    id: link,
    sourceId,
    title: `详情 ${link}`,
    posterUrl: '',
    link,
    description: '简介',
    seasons: [],
    episodeItems,
  };
}

export interface ApiCalls {
  browse: string[];
  detail: string[];
  search: string[];
}

export async function mockApi(page: Page): Promise<ApiCalls> {
  const calls: ApiCalls = { browse: [], detail: [], search: [] };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const match = url.pathname.match(/^\/api\/sources\/([^/]+)\/(\w[\w-]*)$/);
    if (url.pathname === '/api/auth/me')
      return json({
        user: {
          id: 'test-admin',
          username: 'admin',
          role: 'admin',
          createdAt: 1,
          sourceIds: sources.map((source) => source.id),
        },
      });
    if (url.pathname === '/api/library') return json({ favorites: [], recent: [] });
    if (url.pathname === '/api/library/watch') {
      return json(route.request().method() === 'POST' ? { watch: route.request().postDataJSON() } : { watch: null });
    }
    if (url.pathname === '/api/sources') return json(sources);
    if (url.pathname === '/api/config') return json({ backendUrl: 'http://capy.test', persisted: true });
    if (url.pathname === '/api/status') return json({ backendUrl: 'http://capy.test', sources: {} });
    if (match) {
      const [, id, action] = match;
      const pageNumber = Number(url.searchParams.get('page') || 1);
      if (action === 'browse') {
        calls.browse.push(`${id}:${url.searchParams.get('module')}:${pageNumber}`);
        return json(listPage(id!, pageNumber));
      }
      if (action === 'search') {
        calls.search.push(`${id}:${url.searchParams.get('q')}`);
        return json({ ...listPage(id!, 1, `${url.searchParams.get('q')}-`), hasMore: true });
      }
      if (action === 'detail') {
        calls.detail.push(url.searchParams.get('link')!);
        return json(detailFor(id!, url.searchParams.get('link')!));
      }
      if (action === 'playback')
        return json({ sources: [{ src: '/media-not-found.mp4', type: 'video/mp4', title: '线路一' }] });
      if (action === 'playback-report') return json({ ok: true });
    }
    return json({ error: 'not mocked' }, 404);
  });
  return calls;
}

export const test = base.extend<{ api: ApiCalls }>({
  // Automatic, so no test can accidentally reach a real API server through the dev proxy.
  api: [
    async ({ page }, use) => {
      await use(await mockApi(page));
    },
    { auto: true },
  ],
});
export { expect } from '@playwright/test';
