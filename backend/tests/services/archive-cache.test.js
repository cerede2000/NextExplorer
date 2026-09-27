import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What the cache of decompressed archives may keep.
 *
 * Every copy in it can be made again from the archive it came from, so nothing
 * here is ever missed — which is what makes a budget the right answer rather
 * than a worry. Without one, two backups opened once fill a cache directory
 * somebody sized for thumbnails, and the thumbnails go instead.
 */

let currentEnv;

afterEach(async () => {
  try {
    await currentEnv?.requireFresh('src/services/archiveCacheService').stopArchiveCacheWork();
  } catch (_) {
    // Never loaded, which is as stopped as it gets.
  }
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'archive-cache-', env });
  const service = currentEnv.requireFresh('src/services/archiveCacheService');
  const directory = service.cacheDirectory();
  await fs.mkdir(directory, { recursive: true });
  return { service, directory };
};

/**
 * A cached copy of the given size, last read `agedMs` ago.
 *
 * The names are what this service writes — a version, then a hash — because
 * that shape is the whole of its permission to remove anything.
 */
const writeCached = async (directory, name, { size = 1024, agedMs = 0 } = {}) => {
  const file = path.join(directory, name);
  await fs.writeFile(file, Buffer.alloc(size));
  if (agedMs) {
    const when = new Date(Date.now() - agedMs);
    await fs.utimes(file, when, when);
  }
  return file;
};

const remaining = async (directory) => (await fs.readdir(directory)).sort();

describe('sweeping the cache of decompressed archives', () => {
  it('keeps what is recent and within the budget', async () => {
    const { service, directory } = await seed();
    await writeCached(directory, 'v1-aaaa.inner');
    await writeCached(directory, 'v1-bbbb.inner');

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual(['v1-aaaa.inner', 'v1-bbbb.inner']);
  });

  it('takes one nobody has opened in a long time', async () => {
    const { service, directory } = await seed();
    await writeCached(directory, 'v1-0d0d.inner', { agedMs: 400 * 24 * 60 * 60 * 1000 });
    await writeCached(directory, 'v1-e0e0.inner');

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual(['v1-e0e0.inner']);
  });

  /** Least recently read first: what costs least to make again. */
  it('comes down to the budget, oldest first', async () => {
    const { service, directory } = await seed({ ARCHIVE_CACHE_MAX_SIZE: '3K' });
    await writeCached(directory, 'v1-f1f1.inner', { size: 2048, agedMs: 3 * 60 * 60 * 1000 });
    await writeCached(directory, 'v1-f2f2.inner', { size: 2048, agedMs: 2 * 60 * 60 * 1000 });
    await writeCached(directory, 'v1-f3f3.inner', { size: 2048, agedMs: 60 * 60 * 1000 });

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual(['v1-f3f3.inner']);
  });

  /** A copy being made is not rubbish; one abandoned by a stopped run is. */
  it('takes a temporary file a stopped run left behind', async () => {
    const { service, directory } = await seed();
    await writeCached(directory, 'v1-aaaa.inner.tmp-1-2', { agedMs: 3 * 60 * 60 * 1000 });
    await writeCached(directory, 'v1-bbbb.inner.tmp-1-2');

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual(['v1-bbbb.inner.tmp-1-2']);
  });

  /**
   * `/cache` is a directory on somebody's disk, and what else they keep there
   * is theirs: the names this service writes are what it may take away.
   */
  it('never touches a file it did not write', async () => {
    const { service, directory } = await seed({ ARCHIVE_CACHE_MAX_SIZE: '1K' });
    await writeCached(directory, 'notes.txt', { size: 4096, agedMs: 400 * 24 * 60 * 60 * 1000 });
    await writeCached(directory, 'inner', { size: 4096 });

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual(['inner', 'notes.txt']);
  });

  it('passes quietly when nothing has ever been cached', async () => {
    currentEnv = await setupTestEnv({ tag: 'archive-cache-' });
    const service = currentEnv.requireFresh('src/services/archiveCacheService');

    await expect(service.sweepArchiveCache()).resolves.toBeUndefined();
  });
});

/**
 * A tree is a directory rather than a file, and the sweep has to read it as
 * one: its size is what is under it, and taking it means taking all of it.
 */
const writeTree = async (directory, name, { files = 2, size = 1024, agedMs = 0 } = {}) => {
  const tree = path.join(directory, name);
  await fs.mkdir(path.join(tree, 'nested'), { recursive: true });
  for (let index = 0; index < files; index += 1) {
    await fs.writeFile(path.join(tree, 'nested', `file-${index}`), Buffer.alloc(size));
  }
  if (agedMs) {
    const when = new Date(Date.now() - agedMs);
    await fs.utimes(tree, when, when);
  }
  return tree;
};

describe('sweeping the extracted trees of solid archives', () => {
  it('counts what is under a tree, not the directory entry', async () => {
    const { service, directory } = await seed({ ARCHIVE_CACHE_MAX_SIZE: '3K' });
    // Six kilobytes in two files, against a budget of three.
    await writeTree(directory, 'v1-aaaa.tree', { files: 2, size: 3072 });

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual([]);
  });

  it('keeps one that fits, whole', async () => {
    const { service, directory } = await seed();
    await writeTree(directory, 'v1-bbbb.tree', { files: 2, size: 16 });

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual(['v1-bbbb.tree']);
    expect(await fs.readdir(path.join(directory, 'v1-bbbb.tree', 'nested'))).toHaveLength(2);
  });

  it('takes one nobody has opened in a long time', async () => {
    const { service, directory } = await seed();
    await writeTree(directory, 'v1-cccc.tree', { agedMs: 400 * 24 * 60 * 60 * 1000 });

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual([]);
  });

  /** Files and trees are the same cache, and share its budget. */
  it('weighs trees and copies against one budget, oldest first', async () => {
    const { service, directory } = await seed({ ARCHIVE_CACHE_MAX_SIZE: '5K' });
    await writeTree(directory, 'v1-d1d1.tree', {
      files: 1,
      size: 4096,
      agedMs: 3 * 60 * 60 * 1000,
    });
    await writeCached(directory, 'v1-d2d2.inner', { size: 4096, agedMs: 60 * 60 * 1000 });

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual(['v1-d2d2.inner']);
  });

  it('takes a half-made tree a stopped run left behind', async () => {
    const { service, directory } = await seed();
    await writeTree(directory, 'v1-eeee.tree.tmp-1-2', { agedMs: 3 * 60 * 60 * 1000 });

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual([]);
  });

  it('never touches a directory it did not write', async () => {
    const { service, directory } = await seed({ ARCHIVE_CACHE_MAX_SIZE: '1K' });
    await writeTree(directory, 'somebody-elses-work', { files: 2, size: 4096 });

    await service.sweepArchiveCache();

    expect(await remaining(directory)).toEqual(['somebody-elses-work']);
  });
});
