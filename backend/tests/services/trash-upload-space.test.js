import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The trash never makes an upload fail that it could let through.
 *
 * Its space is recoverable: before an upload is refused for want of room, the
 * trash of the volume it is going to gives back its oldest items. But only
 * when that is enough — emptying someone's trash for an upload that is then
 * refused anyway would destroy their deleted files for nothing.
 */

const fsp = require('fs/promises');
const DAY = 24 * 60 * 60 * 1000;

let envContext;
let guard;
let operations;
let store;
let clock;
let db;
let free;
let now;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  envContext = await setupTestEnv({
    tag: 'trash-upload-space-',
    env: { UPLOAD_STORAGE_RESERVE: '0' },
  });
  clock = load('src/services/trash/clock');
  store = load('src/services/trash/store');
  operations = load('src/services/trash/operations');
  guard = load('src/services/uploadStorageGuard');
  db = await load('src/services/db').getDb();

  now = Date.UTC(2026, 8, 1);
  vi.spyOn(clock, 'now').mockImplementation(() => now);

  // A volume with `free` bytes left, which a purge gives back.
  free = 1000;
  vi.spyOn(fsp, 'statfs').mockImplementation(async () => ({
    bavail: free,
    bsize: 1,
    blocks: 1_000_000_000,
  }));
  const purge = operations.purgeItem;
  vi.spyOn(operations, 'purgeItem').mockImplementation(async (id) => {
    const result = await purge(id);
    if (result.status === 'purged') free += result.item.size;
    return result;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await envContext.cleanup();
});

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const trashFile = async (name, { size, daysAgo }) => {
  now = Date.UTC(2026, 8, 1) - daysAgo * DAY;
  await fs.mkdir(volume('Projects'), { recursive: true });
  await fs.writeFile(volume('Projects', name), 'x'.repeat(size));
  await operations.moveToTrash({ absolutePath: volume('Projects', name) });
  now = Date.UTC(2026, 8, 1);
};

const remaining = () =>
  store
    .listItems(db)
    .map((item) => item.name)
    .sort();

describe('an upload that does not fit', () => {
  it('fits once the oldest trash items give their space back', async () => {
    await trashFile('oldest.bin', { size: 400, daysAgo: 3 });
    await trashFile('older.bin', { size: 400, daysAgo: 2 });
    await trashFile('recent.bin', { size: 400, daysAgo: 1 });

    await expect(
      guard.ensureStorageAvailable(volume('Projects'), 1500, 'destination storage')
    ).resolves.toBeUndefined();

    expect(remaining()).toEqual(['recent.bin']);
  });

  it('is still refused, with the trash untouched, when the trash could not cover it', async () => {
    await trashFile('oldest.bin', { size: 400, daysAgo: 3 });
    await trashFile('recent.bin', { size: 400, daysAgo: 1 });

    await expect(
      guard.ensureStorageAvailable(volume('Projects'), 5000, 'destination storage')
    ).rejects.toMatchObject({ statusCode: 507 });

    expect(remaining()).toEqual(['oldest.bin', 'recent.bin']);
  });

  it('takes nothing from the trash of another volume', async () => {
    await trashFile('oldest.bin', { size: 400, daysAgo: 3 });
    await fs.mkdir(volume('Photos'), { recursive: true });

    await expect(
      guard.ensureStorageAvailable(volume('Photos'), 1200, 'destination storage')
    ).rejects.toMatchObject({ statusCode: 507 });

    expect(remaining()).toEqual(['oldest.bin']);
  });

  it('takes nothing when the upload fits anyway', async () => {
    await trashFile('oldest.bin', { size: 400, daysAgo: 3 });

    await guard.ensureStorageAvailable(volume('Projects'), 900, 'destination storage');

    expect(remaining()).toEqual(['oldest.bin']);
  });
});
