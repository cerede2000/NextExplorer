import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A killed process leaves `holiday.mp4.uploading` behind, and nothing before
 * this removed it. The sweep deletes a file it did not create, on the strength
 * of a name — so what it leaves alone matters as much as what it takes.
 */

let envContext;
let sweepStaleUploadRemnants;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const build = async () => {
  envContext = await setupTestEnv({ tag: 'upload-remnants-test-' });
  ({ sweepStaleUploadRemnants } = envContext.requireFresh('src/services/uploadRemnants'));
  return envContext.volumeDir;
};

/** A file last written `ageMs` ago. */
const writeAged = async (dir, name, ageMs) => {
  const target = path.join(dir, name);
  await fs.writeFile(target, 'partial');
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(target, when, when);
  return target;
};

const exists = async (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('sweeping the remains of interrupted uploads', () => {
  it('removes one nothing has written to in a day', async () => {
    const dir = await build();
    const remnant = await writeAged(dir, 'holiday.mp4.uploading', 2 * DAY);

    expect(await sweepStaleUploadRemnants(dir)).toBe(1);
    expect(await exists(remnant)).toBe(false);
  });

  // An upload in flight writes to its temporary file continuously. Sweeping it
  // would break the very thing the sweep runs alongside.
  it('leaves an upload that is still running', async () => {
    const dir = await build();
    const inFlight = await writeAged(dir, 'movie.mkv.uploading', 5 * 1000);

    expect(await sweepStaleUploadRemnants(dir)).toBe(0);
    expect(await exists(inFlight)).toBe(true);
  });

  it('leaves ordinary files alone', async () => {
    const dir = await build();
    const kept = [
      await writeAged(dir, 'notes.txt', 2 * DAY),
      await writeAged(dir, 'uploading.txt', 2 * DAY),
      await writeAged(dir, 'holiday.mp4', 2 * DAY),
      await writeAged(dir, 'report.uploading.pdf', 2 * DAY),
    ];

    expect(await sweepStaleUploadRemnants(dir)).toBe(0);
    for (const target of kept) {
      // eslint-disable-next-line no-await-in-loop
      expect(await exists(target)).toBe(true);
    }
  });

  // Someone's own file, old and named unfortunately, is not ours to delete on
  // sight — but it is not ours to keep for ever either. The threshold is the
  // whole of the protection, so it has to be the threshold that decides.
  it('takes a day to decide', async () => {
    const dir = await build();
    const young = await writeAged(dir, 'yesterday.uploading', 23 * HOUR);
    const old = await writeAged(dir, 'the-day-before.uploading', 25 * HOUR);

    expect(await sweepStaleUploadRemnants(dir)).toBe(1);
    expect(await exists(young)).toBe(true);
    expect(await exists(old)).toBe(false);
  });

  it('stays in the folder it was given', async () => {
    const dir = await build();
    const nested = path.join(dir, 'holiday');
    await fs.mkdir(nested, { recursive: true });
    const deeper = await writeAged(nested, 'inner.mp4.uploading', 2 * DAY);
    const directory = path.join(dir, 'a-folder.uploading');
    await fs.mkdir(directory, { recursive: true });

    expect(await sweepStaleUploadRemnants(dir)).toBe(0);
    expect(await exists(deeper)).toBe(true);
    expect(await exists(directory)).toBe(true);
  });

  // The tidying before an upload must never be the reason it fails.
  it('says nothing when the folder is not there', async () => {
    const dir = await build();

    await expect(sweepStaleUploadRemnants(path.join(dir, 'no-such-folder'))).resolves.toBe(0);
  });
});
