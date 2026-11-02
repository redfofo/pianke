import { describe, expect, it } from 'vitest';
import {
  createLimiter,
  editableFilters,
  formatPosition,
  isUnfinished,
  knownPages,
  parsePage,
  resolveModule,
  resolveParams,
} from './browse';
import type { Source } from './types';

const source = (modules: Source['modules']): Source => ({
  id: 's',
  title: 'S',
  description: '',
  version: '1',
  capabilities: ['browser', 'search'],
  icon: '',
  modules,
});

describe('resolveModule', () => {
  const modules = [
    { id: 'history', title: '观看历史', params: [] },
    { id: 'hot', title: '热门', params: [] },
    { id: 'new', title: '最新', params: [] },
  ];
  it('uses the requested module when it exists', () => {
    expect(resolveModule(source(modules), 'new')?.id).toBe('new');
  });
  it('skips history-like modules by default', () => {
    expect(resolveModule(source(modules), undefined)?.id).toBe('hot');
    expect(resolveModule(source(modules), 'missing')?.id).toBe('hot');
  });
  it('prefers the short-drama module when present', () => {
    expect(resolveModule(source([...modules, { id: 'hongguo-short', title: '短剧', params: [] }]), undefined)?.id).toBe(
      'hongguo-short',
    );
  });
  it('falls back to the first module and handles missing sources', () => {
    expect(resolveModule(source([{ id: 'history', title: '历史', params: [] }]), undefined)?.id).toBe('history');
    expect(resolveModule(undefined, 'x')).toBeUndefined();
  });
});

describe('resolveParams / editableFilters', () => {
  const module = {
    id: 'm',
    title: 'M',
    params: [
      { name: 'page', title: '页', type: 'page' },
      { name: 'sort', title: '排序', type: 'enumeration', enumOptions: [{ title: '热度', value: 'hot' }] },
      { name: 'year', title: '年份', type: 'input', defaultValue: '2024' },
      { name: 'kind', title: '类型', type: 'constant', value: 'drama' },
    ],
  };
  it('reads p_ query keys before defaults and drops paging params', () => {
    expect(resolveParams(module, new URLSearchParams({ p_year: '2020' }))).toEqual({
      sort: 'hot',
      year: '2020',
      kind: 'drama',
    });
  });
  it('excludes constants from the editable filters', () => {
    const params = resolveParams(module, new URLSearchParams());
    expect(editableFilters(module, params).map((param) => param.name)).toEqual(['sort', 'year']);
  });
});

describe('paging helpers', () => {
  it('ignores the "page + 1" placeholder page count without a total', () => {
    expect(knownPages(3, 4)).toBeUndefined();
    expect(knownPages(3, 4, 80)).toBe(4);
    expect(knownPages(1, 12)).toBe(12);
    expect(knownPages(1, 50_000, 1)).toBe(10000);
    expect(knownPages(1, undefined)).toBeUndefined();
  });
  it('parses page numbers defensively', () => {
    expect(parsePage('3')).toBe(3);
    expect(parsePage('2.7')).toBe(2);
    expect(parsePage('-1')).toBe(1);
    expect(parsePage('abc')).toBe(1);
    expect(parsePage(undefined)).toBe(1);
  });
});

describe('progress helpers', () => {
  it('formats positions as m:ss', () => {
    expect(formatPosition(0)).toBe('0:00');
    expect(formatPosition(65.9)).toBe('1:05');
    expect(formatPosition(3600)).toBe('60:00');
  });
  it('treats the last two seconds as finished', () => {
    expect(isUnfinished(30, 100)).toBe(true);
    expect(isUnfinished(99, 100)).toBe(false);
    expect(isUnfinished(0, 100)).toBe(false);
    expect(isUnfinished(10, 0)).toBe(true);
  });
});

describe('createLimiter', () => {
  it('never runs more than the limit at once and keeps results in order', async () => {
    const limited = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = (value: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (value === 3) throw new Error('boom');
      return value;
    };
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((value) => limited(task(value))));
    expect(peak).toBe(2);
    expect(results.map((result) => (result.status === 'fulfilled' ? result.value : 'error'))).toEqual([
      1,
      2,
      'error',
      4,
      5,
    ]);
  });
});
