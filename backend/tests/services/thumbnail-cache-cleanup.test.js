import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { substituteModule } from '../helpers/substitute-module.js';

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
let releaseHeldWrite = null;
let restoreModule = null;

const SERVICE_FILE = fileURLToPath(
  new URL('../../src/services/thumbnailService.js', import.meta.url)
);
const HOUR = 60 * 60 * 1000;
const CURRENT = 'v3-';
const OLD = 'v2-';
const sha1 = (n) => String(n).padStart(40, 'a');
/** How releases up to 2.0.3 named a thumbnail: the key, and no version. */
const legacy = (n) => `${sha1(n)}.webp`;
/** A thumbnail's temporary name as it is written now, and as 2.0.x wrote it. */
const tempOf = (name) => `${name}.tmp-4242-${Date.now()}-${randomUUID()}`;
const legacyTempOf = (name) => `${name}.tmp-4242-${Date.now()}`;

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
  // A write held open would keep the queue from ever going idle.
  releaseHeldWrite?.();
  releaseHeldWrite = null;
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
  restoreModule?.();
  restoreModule = null;
});

/**
 * A sharp whose file writes begin, and then wait to be told to finish.
 *
 * `started` resolves with the temporary path once the partial file is on disk.
 */
const holdThumbnailWrite = () => {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let reportStarted;
  const started = new Promise((resolve) => {
    reportStarted = resolve;
  });

  const pipeline = {
    rotate: () => pipeline,
    resize: () => pipeline,
    webp: () => pipeline,
    toFile: async (file) => {
      await fs.writeFile(file, 'half a thumbnail');
      reportStarted(file);
      await released;
      await fs.writeFile(file, 'a thumbnail');
    },
  };
  const sharp = Object.assign(() => pipeline, {
    concurrency: () => 1,
    cache: () => ({}),
    counters: () => ({}),
  });

  return { sharp, started, release };
};

const eventually = async (probe) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition never held');
};

describe('entries from an older cache version', () => {
  it('are removed', async () => {
    const { service, dir } = await setup();
    await write(dir, `${OLD}${sha1(1)}.webp`);
    await write(dir, `${CURRENT}${sha1(2)}.webp`);

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual([`${CURRENT}${sha1(2)}.webp`]);
  });
});

describe('thumbnails named before the version prefix existed', () => {
  /**
   * Releases up to 2.0.3 wrote `<sha1>.webp`. The cleanup only knew the
   * versioned name, so these were neither counted nor ever removed.
   */
  it('are removed', async () => {
    const { service, dir } = await setup();
    await write(dir, legacy(1));
    await write(dir, legacy(2));
    await write(dir, `${CURRENT}${sha1(3)}.webp`);

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual([`${CURRENT}${sha1(3)}.webp`]);
  });
});

describe('temporary files a write left behind', () => {
  /** The aged thumbnail kept alongside says the age rule is the temporaries' alone. */
  it('are removed once clearly abandoned, under either naming', async () => {
    const { service, dir } = await setup();
    const kept = await write(dir, `${CURRENT}${sha1(1)}.webp`, { ageMs: 2 * HOUR });
    await write(dir, tempOf(`${CURRENT}${sha1(1)}.webp`), { ageMs: 2 * HOUR });
    await write(dir, legacyTempOf(legacy(2)), { ageMs: 2 * HOUR });

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual([kept]);
  });

  it('are kept while recent', async () => {
    const { service, dir } = await setup();
    const names = [
      await write(dir, tempOf(`${CURRENT}${sha1(1)}.webp`), { ageMs: 10 * 60 * 1000 }),
      await write(dir, legacyTempOf(`${CURRENT}${sha1(2)}.webp`)),
    ];

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });

  it('neither count towards the limit nor are trimmed to meet it', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '2' });
    const names = [];
    for (let i = 0; i < 2; i += 1) names.push(await write(dir, `${CURRENT}${sha1(i)}.webp`));
    for (let i = 10; i < 13; i += 1) {
      names.push(await write(dir, tempOf(`${CURRENT}${sha1(i)}.webp`)));
    }

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });

  /**
   * Removing them must not use up the trim the limit calls for. Taking the
   * larger of "removable" and "over the limit" stopped two thumbnails short.
   */
  it('are removed on top of the trim a cache past its limit needs', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '2' });
    for (let i = 0; i < 4; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);
    for (let i = 10; i < 12; i += 1) {
      await write(dir, tempOf(`${CURRENT}${sha1(i)}.webp`), { ageMs: 2 * HOUR });
    }

    await service.cleanupThumbnailCache();

    const left = await remaining(dir);
    expect(left.filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(left).toHaveLength(2);
  });

  it('are left alone when the name is not one of ours', async () => {
    const { service, dir } = await setup();
    const names = [
      await write(dir, 'notes.txt.tmp-4242-1700000000000', { ageMs: 2 * HOUR }),
      await write(dir, 'v3-nothexadecimal.webp.tmp-4242-1700000000000', { ageMs: 2 * HOUR }),
    ];

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });

  /**
   * The queues stop waiting for a job after thirty seconds and the job goes on,
   * so a write that slow is exactly the one whose temporary file looks
   * abandoned. Taking it would fail the rename it is still heading for.
   */
  it('are kept however old while their write is still going on', async () => {
    const held = holdThumbnailWrite();
    releaseHeldWrite = held.release;
    restoreModule = substituteModule(SERVICE_FILE, 'sharp', held.sharp);
    const { service, dir } = await setup();
    const source = path.join(currentEnv.volumeDir, 'photo.jpg');
    await fs.writeFile(source, 'a photo');

    await service.queueThumbnailGeneration(source);
    const tempFile = await held.started;
    const longAgo = new Date(Date.now() - 2 * HOUR);
    await fs.utimes(tempFile, longAgo, longAgo);

    await service.cleanupThumbnailCache();
    expect(await remaining(dir)).toContain(path.basename(tempFile));

    held.release();
    const thumbnail = await eventually(async () =>
      (await remaining(dir)).find((name) => /^v3-[a-f0-9]{40}\.webp$/.test(name))
    );
    expect(await remaining(dir)).toEqual([thumbnail]);
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
  /** Zero lifts the limit on the count, and must not mean "delete everything". */
  it('keeps every current thumbnail, however many', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '0' });
    const names = [];
    for (let i = 0; i < 4; i += 1) names.push(await write(dir, `${CURRENT}${sha1(i)}.webp`));

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });

  /**
   * It used to leave the directory unmanaged: another version's thumbnails,
   * those past their lifetime and abandoned temporary files stayed for good.
   */
  it('still removes what is outdated, expired or abandoned', async () => {
    const { service, dir } = await setup({
      THUMBNAIL_CACHE_MAX_FILES: '0',
      THUMBNAIL_CACHE_TTL_DAYS: '1',
    });
    const kept = await write(dir, `${CURRENT}${sha1(1)}.webp`);
    await write(dir, `${OLD}${sha1(2)}.webp`);
    await write(dir, legacy(3));
    await write(dir, `${CURRENT}${sha1(4)}.webp`, { ageMs: 3 * 24 * HOUR });
    await write(dir, tempOf(`${CURRENT}${sha1(5)}.webp`), { ageMs: 2 * HOUR });

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual([kept]);
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

describe('a cache past its limit, trimmed', () => {
  it('gives up its oldest thumbnails first, whatever order the directory lists them in', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_MAX_FILES: '2' });
    // Listed alphabetically, the newest come first.
    const newest = await write(dir, `${CURRENT}${sha1(0)}.webp`, { ageMs: 1 * HOUR });
    const newer = await write(dir, `${CURRENT}${sha1(1)}.webp`, { ageMs: 2 * HOUR });
    await write(dir, `${CURRENT}${sha1(2)}.webp`, { ageMs: 3 * HOUR });
    await write(dir, `${CURRENT}${sha1(3)}.webp`, { ageMs: 4 * HOUR });

    await service.cleanupThumbnailCache();

    expect(await remaining(dir)).toEqual([newest, newer].sort());
  });
});

describe('the thumbnail cleanup schedule', () => {
  const MINUTE = 60 * 1000;
  // Captured before any test fakes the timers, so real time can still be waited on.
  const realSetTimeout = setTimeout;
  const pause = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
  const env = { THUMBNAIL_CACHE_MAX_FILES: '1', THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS: '60000' };

  /** Move the clock on a minute at a time until `probe` holds, and say whether it did. */
  const advanceUntil = async (probe, minutes = 30) => {
    for (let i = 0; i < minutes; i += 1) {
      if (await probe()) return true;
      await vi.advanceTimersByTimeAsync(MINUTE);
      await pause(5);
    }
    return probe();
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('trims the cache by itself, and goes on doing so with no thumbnail generated', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { dir } = await setup(env);
    for (let i = 0; i < 3; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);

    expect(await advanceUntil(async () => (await remaining(dir)).length === 1)).toBe(true);

    // Nothing is generated from here on: only the clock can bring the next pass.
    for (let i = 3; i < 6; i += 1) await write(dir, `${OLD}${sha1(i)}.webp`);
    expect(await advanceUntil(async () => (await remaining(dir)).length === 1)).toBe(true);
  });

  it('stays stopped once asked, even with a pass under way', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service, dir } = await setup(env);
    for (let i = 0; i < 3; i += 1) await write(dir, `${CURRENT}${sha1(i)}.webp`);

    const pass = service.cleanupThumbnailCache();
    await service.stopThumbnailWork();
    // The pass under way has finished by the time the stop returns.
    expect(await remaining(dir)).toHaveLength(1);
    await pass;

    for (let i = 3; i < 6; i += 1) await write(dir, `${OLD}${sha1(i)}.webp`);
    expect(await advanceUntil(async () => (await remaining(dir)).length < 4)).toBe(false);
  });
});
