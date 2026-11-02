import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { TranscodingManager } from './transcoding.js';

test('transcode cleanup preserves the mounted cache root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'short-transcodes-'));
  const cache = join(root, 'cache');
  const previous = process.env.TRANSCODE_DIR;
  await mkdir(join(cache, 'stale'), { recursive: true });
  await writeFile(join(cache, 'stale', 'segment.ts'), 'stale');
  process.env.TRANSCODE_DIR = cache;

  try {
    const manager = new TranscodingManager({ warn() {} } as unknown as FastifyBaseLogger);
    await manager.close();
    assert.equal((await stat(cache)).isDirectory(), true);
    assert.deepEqual(await readdir(cache), []);
  } finally {
    if (previous === undefined) delete process.env.TRANSCODE_DIR;
    else process.env.TRANSCODE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
