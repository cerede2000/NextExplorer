import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What the thumbnail cache throws away.
 *
 * It is the only thing standing between a cache and a full disk, and it deletes
 * files — so both halves are worth stating. Keeping too much fills the volume;
 * deleting too much sends every thumbnail back through ffmpeg, which is the
 * cost the cache exists to avoid.
 *
 * None of it was covered, because it is reached only through timers.
 */

let currentEnv;

const CURRENT = 'v3-';
const OLD = 'v2-';
const sha1 = (n) => String(n).padStart(40, 'a');

const setup = async (env = {}) => {
  currentEnv = await setupTestEnv({
    tag: 'thumb-cleanup-',
    env: { THUMBNAILS: 'true', ...env },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/services/ffmpegRunner',
      'src/services/thumbnailService',
    ],
  });

  const service = currentEnv.requireFresh('src/services/thumbnailService');
  const { directories } = currentEnv.requireFresh('src/config/index');
  await fs.mkdir(directories.thumbnails, { recursive: true });
  return { service, dir: directories.thumbnails };
};

/** A cache entry, optionally aged. */
const write = async (dir, name, { ageMs = 0 } = {}) => {
  const file = path.join(dir, name);
  await fs.writeFile(file, 'webp');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(file, when, when);
  }
  return name;
};

const remaining = async (dir) => (await fs.readdir(dir)).sort();

afterEach(async () => {
  if (currentEnv) {
    const service = currentEnv.loaded?.('src/services/thumbnailService');
    try {
      await service?.stopThumbnailWork?.();
    } catch (_) {
      // Nothing in flight.
    }
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

describe('entries from an older cache version', () => {
  it('are removed', async () => {
    const { service, dir } = await setup();
    await write(dir, `${OLD}${sha1(1)}.webp`);
    await write(dir, `${CURRENT}${sha1(2)}.webp`);

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual([`${CURRENT}${sha1(2)}.webp`]);
  });
});

describe('entries nobody has looked at for a long time', () => {
  it('are removed once past their lifetime', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_TTL_DAYS: '1' });
    await write(dir, `${CURRENT}${sha1(1)}.webp`, { ageMs: 3 * 24 * 60 * 60 * 1000 });
    await write(dir, `${CURRENT}${sha1(2)}.webp`);

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual([`${CURRENT}${sha1(2)}.webp`]);
  });

  /** A lifetime of zero is what turns the rule off, not what expires everything. */
  it('are kept when no lifetime is set', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_TTL_DAYS: '0' });
    await write(dir, `${CURRENT}${sha1(1)}.webp`, { ageMs: 365 * 24 * 60 * 60 * 1000 });

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toHaveLength(1);
  });
});

describe('a cache that has grown past its limit', () => {
  it('is brought back under it', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '2' });
    for (let i = 0; i < 5; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);

    await service.cleanupThumbnailCache();

    expect((await remaining(dir)).length).toBeLessThanOrEqual(2);
  });

  it('deletes no more than one batch at a time', async () => {
    const { service, dir } = await setup({
      THUMBNAIL_CACHE_MAX_FILES: '1',
      THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE: '2',
    });
    for (let i = 0; i < 6; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toHaveLength(4);
  });
});

describe('a file in that directory that is not a thumbnail', () => {
  /**
   * The name pattern says what belongs to this cache. It used to decide which
   * entries were expired or outdated and then be dropped for the overflow trim,
   * which took every file in the directory — so anything else living there both
   * counted towards the limit and could be deleted to satisfy it.
   */
  it('is not deleted to make room', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '1' });
    await write(dir, 'please-keep-me.txt');
    for (let i = 0; i < 4; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toContain('please-keep-me.txt');
  });

  it('does not count towards the limit', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '3' });
    await write(dir, 'notes.txt');
    await write(dir, 'other.log');
    for (let i = 0; i < 3; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);

    await service.cleanupThumbnailCache();

    const left = await remaining(dir);
    expect(left.filter((name) => name.endsWith('.webp'))).toHaveLength(3);
  });

  it('is left alone even when it looks nearly right', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '1' });
    await write(dir, 'v3-nothexadecimal.webp');
    for (let i = 0; i < 3; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toContain('v3-nothexadecimal.webp');
  });
});

describe('a cache within its limits', () => {
  it('is left entirely alone', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '10' });
    const names = [];
    for (let i = 0; i < 3; i += 1) names.push(await write(dir, `${CURRENT}${sha1(i)}.webp`));

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });
});

describe('a cache with the limit switched off', () => {
  /** Zero means "do not manage this", and must not mean "delete everything". */
  it('is not touched at all', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '0' });
    await write(dir, `${OLD}${sha1(1)}.webp`);
    for (let i = 0; i < 4; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toHaveLength(5);
  });
});

describe('two cleanups asked for at once', () => {
  it('run as one', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '1' });
    for (let i = 0; i < 4; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);

    const [first, second] = await Promise.all([
      service.cleanupThumbnailCache(),
      service.cleanupThumbnailCache(),
    ]);

    expect(first).toBe(second);
  });
});
