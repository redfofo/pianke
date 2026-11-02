import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSourceId, enabledSources, orderSources } from './stores';
import type { Source } from './types';

const source = (id: string, error?: string): Source => ({
  id,
  title: id,
  description: '',
  version: '',
  capabilities: ['browser'],
  icon: '',
  modules: [],
  error,
});
const ids = (sources: Source[]) => sources.map((row) => row.id);

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('defaultSourceId', () => {
  it('prefers the last used source, skipping unavailable ones', () => {
    const sources = [source('a', '坏了'), source('b'), source('c')];
    expect(defaultSourceId(sources, '')).toBe('b');
    expect(defaultSourceId(sources, 'c')).toBe('c');
    expect(defaultSourceId(sources, 'a')).toBe('b');
    expect(defaultSourceId([], 'a')).toBe('');
  });
  it('falls back to an unavailable source when nothing else is enabled', () => {
    expect(defaultSourceId([source('a', '坏了')], '')).toBe('a');
  });
});

describe('enabledSources / orderSources', () => {
  it('keeps hidden preferences when upstream removes and restores a source', () => {
    expect(ids(enabledSources([source('a'), source('b')], ['a'], []))).toEqual(['b']);
    expect(ids(enabledSources([source('b')], ['a'], []))).toEqual(['b']);
    expect(ids(enabledSources([source('a'), source('b'), source('c')], ['a'], []))).toEqual(['b', 'c']);
    expect(defaultSourceId(enabledSources([source('a'), source('b')], ['a', 'b'], []), 'a')).toBe('');
  });
  it('applies the saved order and appends unknown sources in upstream order', () => {
    const sources = [source('a'), source('b'), source('c'), source('d')];
    expect(ids(orderSources(sources, ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
    expect(ids(orderSources(sources, ['gone', 'd']))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(enabledSources(sources, ['a'], ['c', 'a']))).toEqual(['c', 'b', 'd']);
  });
});

describe('usePreferences persistence', () => {
  it('restores hidden sources, order and theme after a reload', async () => {
    const first = (await import('./preferences')).usePreferences;
    first.getState().setSourceEnabled('a', false);
    first.getState().setSourceOrder(['b', 'a']);
    first.getState().setTheme('dark');
    expect(first.getState().disabledSources).toEqual(['a']);

    vi.resetModules();
    const reloaded = (await import('./preferences')).usePreferences;
    expect(reloaded.getState().disabledSources).toEqual(['a']);
    expect(reloaded.getState().sourceOrder).toEqual(['b', 'a']);
    expect(reloaded.getState().theme).toBe('dark');
    reloaded.getState().setSourceEnabled('a', true);
    expect(reloaded.getState().disabledSources).toEqual([]);
    expect(localStorage.getItem('mujian-disabled-sources')).toBe('[]');
  });
  it('ignores corrupt stored values', async () => {
    localStorage.setItem('mujian-disabled-sources', '{not json');
    localStorage.setItem('mujian-source-order', '[1, "b"]');
    const { usePreferences } = await import('./preferences');
    expect(usePreferences.getState().disabledSources).toEqual([]);
    expect(usePreferences.getState().sourceOrder).toEqual(['b']);
  });
});
