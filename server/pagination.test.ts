import test from 'node:test';
import assert from 'node:assert/strict';
import { pageInfo } from './pagination.js';

test('pageInfo prefers explicit flags, then pageCount, then a non-empty page', () => {
  assert.deepEqual(pageInfo({ hasMore: false, pageCount: 9 }, 1, 20), { hasMore: false, pageCount: 9 });
  assert.deepEqual(pageInfo({ has_more: true }, 3, 20), { hasMore: true });
  assert.deepEqual(pageInfo({ total: 55632, pageCount: 1391 }, 1, 40), { hasMore: true, total: 55632, pageCount: 1391 });
  assert.deepEqual(pageInfo({ total: 55632, pageCount: 1391 }, 1391, 32), { hasMore: false, total: 55632, pageCount: 1391 });
  assert.deepEqual(pageInfo({ total: null, pageCount: 2 }, 1, 20), { hasMore: true, pageCount: 2 }, 'placeholder pageCount still means another page');
  assert.deepEqual(pageInfo({ total: null, pageCount: 1 }, 1, 2), { hasMore: false, pageCount: 1 });
  assert.deepEqual(pageInfo({ pageCount: 5 }, 2, 0), { hasMore: false, pageCount: 5 }, 'an empty page ends paging even if pageCount disagrees');
  assert.deepEqual(pageInfo(undefined, 1, 20), { hasMore: true }, 'bare widget arrays fall back to guessing');
  assert.deepEqual(pageInfo(undefined, 4, 0), { hasMore: false });
  assert.deepEqual(pageInfo({ total: -1, pageCount: '3' }, 1, 20), { hasMore: true }, 'malformed counts are ignored');
});
