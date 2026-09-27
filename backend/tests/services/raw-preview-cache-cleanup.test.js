import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { substituteModule } from '../helpers/substitute-module.js';

/**
 * What the RAW preview cache throws away.
 *
 * An embedded preview is a full-size JPEG copied out of a RAW file, for the
 * viewer and on the way to the photo's thumbnail. Nothing removed one: the key
 * includes the RAW file's modification time, so every edit of a photo left the
 * previous preview behind, and a crash left its temporary file. It is bounded
 * now by the thumbnails' rules and settings, with a file limit of its own.
 */

// Captured before any test fakes the timers, so real time can still be waited on.
const realSetTimeout = globalThis.setTimeout;
const pause = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const SERVICE_FILE = fileURLToPath(
  new URL('../../src/services/rawPreviewService.js', import.meta.url)
);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const sha1 = (n) => String(n).padStart(40, 'a');
const preview = (n, version = 1) => `v${version}-${sha1(n)}.jpg`;
const tempOf = (name) => `${name}.tmp-4242-1700000000000`;

let currentEnv = null;
let releaseHeldExtraction = null;
let restoreModule = null;

const setup = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'raw-preview-cleanup-', env });
  const service = currentEnv.requireFresh('src/services/rawPreviewService');
  const dir = path.join(currentEnv.cacheDir, 'raw-previews');
  await fs.mkdir(dir, { recursive: true });
  return { service, dir };
};

/** A cache entry, optionally aged. */
const write = async (dir, name, { ageMs = 0 } = {}) => {
  const file = path.join(dir, name);
  await fs.writeFile(file, 'jpeg');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(file, when, when);
  }
  return name;
};

const remaining = async (dir) => (await fs.readdir(dir)).sort();

const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false
  );

afterEach(async () => {
  // A held extraction would keep the service from ever settling.
  releaseHeldExtraction?.();
  releaseHeldExtraction = null;
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
  vi.useRealTimers();
  restoreModule?.();
  restoreModule = null;
});

/**
 * An exiftool whose preview extraction begins, and then waits to be told to
 * finish. `started` resolves with the temporary path once it is on disk.
 */
const holdExtraction = () => {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let reportStarted;
  const started = new Promise((resolve) => {
    reportStarted = resolve;
  });

  const exiftool = {
    extractPreview: async (_input, output) => {
      await fs.writeFile(output, 'half a preview');
      reportStarted(output);
      await released;
      await fs.writeFile(output, 'a preview');
    },
    extractThumbnail: async () => {
      throw new Error('not reached');
    },
    extractJpgFromRaw: async () => {
      throw new Error('not reached');
    },
  };

  return { module: { exiftool }, started, release };
};

describe('a RAW preview cache past its limit', () => {
  it('loses its oldest previews first', async () => {
    const { service, dir } = await setup({ RAW_PREVIEW_CACHE_MAX_FILES: '2' });
    // Alphabetical order is the reverse of age, so directory order cannot pass for it.
    await write(dir, preview(4), { ageMs: 4 * HOUR });
    await write(dir, preview(3), { ageMs: 3 * HOUR });
    await write(dir, preview(2), { ageMs: 2 * HOUR });
    await write(dir, preview(1), { ageMs: 1 * HOUR });

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual([preview(1), preview(2)]);
  });

  it('deletes no more than one batch at a time', async () => {
    const { service, dir } = await setup({
      RAW_PREVIEW_CACHE_MAX_FILES: '1',
      THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE: '2',
    });
    for (let i = 0; i < 6; i += 1) await write(dir, preview(i));

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toHaveLength(4);
  });
});

describe('a RAW preview cache within its limit', () => {
  it('is left entirely alone', async () => {
    const { service, dir } = await setup({ RAW_PREVIEW_CACHE_MAX_FILES: '10' });
    const names = [];
    for (let i = 0; i < 3; i += 1) names.push(await write(dir, preview(i), { ageMs: HOUR }));

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });
});

describe('a RAW preview nobody has needed for a long time', () => {
  it('is removed once past the cache lifetime', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_TTL_DAYS: '1' });
    await write(dir, preview(1), { ageMs: 3 * DAY });
    await write(dir, preview(2));

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual([preview(2)]);
  });

  /** A lifetime of zero is what turns the rule off, not what expires everything. */
  it('is kept when no lifetime is set', async () => {
    const { service, dir } = await setup({ THUMBNAIL_CACHE_TTL_DAYS: '0' });
    await write(dir, preview(1), { ageMs: 365 * DAY });

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual([preview(1)]);
  });
});

describe('a RAW preview from another cache version', () => {
  it('is removed', async () => {
    const { service, dir } = await setup();
    await write(dir, preview(1, 2));
    await write(dir, preview(2));

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual([preview(2)]);
  });
});

describe('temporary files an extraction left behind', () => {
  it('are removed once clearly abandoned', async () => {
    const { service, dir } = await setup();
    await write(dir, preview(1), { ageMs: 2 * HOUR });
    await write(dir, tempOf(preview(2)), { ageMs: 2 * HOUR });

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual([preview(1)]);
  });

  it('are kept while recent', async () => {
    const { service, dir } = await setup();
    await write(dir, tempOf(preview(1)), { ageMs: 10 * MINUTE });

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual([tempOf(preview(1))]);
  });

  it('neither count towards the limit nor are trimmed to meet it', async () => {
    const { service, dir } = await setup({ RAW_PREVIEW_CACHE_MAX_FILES: '1' });
    const names = [
      await write(dir, preview(1)),
      await write(dir, tempOf(preview(2))),
      await write(dir, tempOf(preview(3))),
    ];

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });

  it('are left alone when the name is not one of ours', async () => {
    const { service, dir } = await setup();
    const names = [
      await write(dir, 'photo.jpg.tmp-4242-1700000000000', { ageMs: 2 * HOUR }),
      await write(dir, 'v1-nothexadecimal.jpg.tmp-4242-1700000000000', { ageMs: 2 * HOUR }),
    ];

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });

  it('are kept however old while their extraction is still going on', async () => {
    const held = holdExtraction();
    releaseHeldExtraction = held.release;
    restoreModule = substituteModule(SERVICE_FILE, 'exiftool-vendored', held.module);
    const { service, dir } = await setup();
    const raw = path.join(currentEnv.volumeDir, 'photo.cr2');
    await fs.writeFile(raw, 'raw bytes');

    const extraction = service.getRawPreviewJpegPath(raw);
    const tempFile = await held.started;
    const longAgo = new Date(Date.now() - 2 * HOUR);
    await fs.utimes(tempFile, longAgo, longAgo);

    await service.cleanupRawPreviewCache();
    expect(await remaining(dir)).toContain(path.basename(tempFile));

    held.release();
    const finalPath = await extraction;
    expect(await remaining(dir)).toEqual([path.basename(finalPath)]);
  });
});

describe('a file in that directory that is not a RAW preview', () => {
  it('is neither counted nor deleted', async () => {
    const { service, dir } = await setup({ RAW_PREVIEW_CACHE_MAX_FILES: '1' });
    const names = [
      await write(dir, 'notes.txt'),
      await write(dir, 'v1-nothexadecimal.jpg'),
      await write(dir, `v1-${sha1(7)}.jpeg`),
      await write(dir, preview(1)),
    ];

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });
});

describe('a RAW preview cache with the limit switched off', () => {
  /** Zero lifts the limit on the count, and must not mean "delete everything". */
  it('keeps every current preview, however many', async () => {
    const { service, dir } = await setup({ RAW_PREVIEW_CACHE_MAX_FILES: '0' });
    const names = [];
    for (let i = 1; i < 6; i += 1) names.push(await write(dir, preview(i)));

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual(names.sort());
  });

  /**
   * It used to leave the directory unmanaged: previews of another version,
   * those past their lifetime and abandoned temporary files stayed for good.
   */
  it('still removes what is outdated, expired or abandoned', async () => {
    const { service, dir } = await setup({ RAW_PREVIEW_CACHE_MAX_FILES: '0' });
    const kept = await write(dir, preview(1));
    await write(dir, preview(2, 2));
    await write(dir, tempOf(preview(3)), { ageMs: 2 * HOUR });
    await write(dir, preview(4), { ageMs: 40 * DAY });

    await service.cleanupRawPreviewCache();

    expect(await remaining(dir)).toEqual([kept]);
  });
});

describe('the RAW preview cleanup schedule', () => {
  const env = { RAW_PREVIEW_CACHE_MAX_FILES: '1', THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS: '60000' };

  /**
   * Move the clock on a minute at a time until `probe` holds, and say whether
   * it did. Real time passes in between for the file operations to land.
   */
  const advanceUntil = async (probe, minutes = 30) => {
    for (let i = 0; i < minutes; i += 1) {
      if (await probe()) return true;
      await vi.advanceTimersByTimeAsync(MINUTE);
      await pause(5);
    }
    return probe();
  };

  it('trims the cache by itself, and goes on doing so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { dir } = await setup(env);
    for (let i = 0; i < 3; i += 1) await write(dir, preview(i));

    expect(await advanceUntil(async () => (await remaining(dir)).length === 1)).toBe(true);

    for (let i = 3; i < 6; i += 1) await write(dir, preview(i));
    expect(await advanceUntil(async () => (await remaining(dir)).length === 1)).toBe(true);
  });

  it('stays stopped once asked, even with a pass under way', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service, dir } = await setup(env);
    for (let i = 0; i < 3; i += 1) await write(dir, preview(i));

    const pass = service.cleanupRawPreviewCache();
    await service.stopRawPreviewWork();
    await pass;
    expect(await remaining(dir)).toHaveLength(1);

    for (let i = 3; i < 6; i += 1) await write(dir, preview(i));
    expect(await advanceUntil(async () => (await remaining(dir)).length < 4)).toBe(false);
  });
});

describe('files outside the thumbnail and RAW preview directories', () => {
  /**
   * Names each cleanup would take, aged well past every rule, placed around the
   * two directories: in the cache root, on the volume, above both, and in
   * look-alike folders on the volume. The directories themselves are emptied,
   * which is what says the cleanups ran at all.
   */
  it('are never touched', async () => {
    const limits = { RAW_PREVIEW_CACHE_MAX_FILES: '1', THUMBNAIL_CACHE_MAX_FILES: '1' };
    const { service: rawPreviews, dir: previewDir } = await setup(limits);
    const thumbnails = currentEnv.requireFresh('src/services/thumbnailService');
    const thumbnailDir = path.join(currentEnv.cacheDir, 'thumbnails');
    await fs.mkdir(thumbnailDir, { recursive: true });

    const tempted = [
      `${sha1(9)}.webp`,
      `v3-${sha1(9)}.webp`,
      tempOf(`v3-${sha1(9)}.webp`),
      preview(9),
      tempOf(preview(9)),
    ];
    const places = [
      currentEnv.cacheDir,
      currentEnv.volumeDir,
      currentEnv.tmpRoot,
      path.join(currentEnv.volumeDir, 'thumbnails'),
      path.join(currentEnv.volumeDir, 'raw-previews'),
    ];
    const planted = [];
    for (const place of places) {
      await fs.mkdir(place, { recursive: true });
      for (const name of tempted) {
        await write(place, name, { ageMs: 40 * DAY });
        planted.push(path.join(place, name));
      }
    }

    await write(thumbnailDir, `${sha1(1)}.webp`, { ageMs: 40 * DAY });
    await write(thumbnailDir, `v3-${sha1(2)}.webp`, { ageMs: 40 * DAY });
    await write(thumbnailDir, tempOf(`v3-${sha1(3)}.webp`), { ageMs: 40 * DAY });
    await write(previewDir, preview(1), { ageMs: 40 * DAY });
    await write(previewDir, preview(2), { ageMs: 40 * DAY });
    await write(previewDir, tempOf(preview(3)), { ageMs: 40 * DAY });

    await thumbnails.cleanupThumbnailCache();
    await rawPreviews.cleanupRawPreviewCache();

    const missing = [];
    for (const file of planted) {
      if (!(await exists(file))) missing.push(file);
    }
    expect(missing).toEqual([]);
    expect(await remaining(thumbnailDir)).toEqual([]);
    expect(await remaining(previewDir)).toEqual([]);
  });
});
