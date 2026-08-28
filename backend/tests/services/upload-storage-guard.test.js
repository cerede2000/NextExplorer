import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A full volume is not only a failed upload: where `/config` shares the
 * filesystem, SQLite stops being able to write and the application stops
 * working for everyone. These check the guard refuses first — and, just as
 * importantly, that it stays out of the way when it cannot know.
 */

let envContext;

const build = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'upload-storage-test-', env });
  return envContext.requireFresh('src/services/uploadStorageGuard');
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('refusing an upload that will not fit', () => {
  it('refuses one larger than the filesystem', async () => {
    const guard = await build();

    await expect(
      guard.ensureStorageAvailable(
        envContext.volumeDir,
        Number.MAX_SAFE_INTEGER,
        'destination storage'
      )
    ).rejects.toThrow(/Not enough storage available in destination storage/);
  });

  it('answers 507, so a client knows not to retry', async () => {
    const guard = await build();

    const error = await guard
      .ensureStorageAvailable(envContext.volumeDir, Number.MAX_SAFE_INTEGER, 'destination storage')
      .then(
        () => null,
        (err) => err
      );

    expect(error).not.toBeNull();
    expect(error.statusCode).toBe(507);
    expect(error.isOperational).toBe(true);
  });

  it('accepts an upload there is room for', async () => {
    const guard = await build();

    await expect(
      guard.ensureStorageAvailable(envContext.volumeDir, 1024, 'destination storage')
    ).resolves.toBeUndefined();
  });

  // The reserve is the whole point: an upload that would fit exactly, leaving
  // nothing for the database beside it, is the one that takes the instance
  // down. Both sizes below are measured against one reading of the free space,
  // and both sit tens of megabytes away from the boundary, so what separates
  // them is the reserve rather than the disk moving under the test.
  it('refuses one that fits only by eating into the reserve', async () => {
    const guard = await build({ UPLOAD_STORAGE_RESERVE: '64M' });
    const available = await guard.getAvailableBytes(envContext.volumeDir);
    expect(Number.isFinite(available)).toBe(true);

    const megabytes = (count) => count * 1024 * 1024;

    // Room on the disk, none left over.
    await expect(
      guard.ensureStorageAvailable(
        envContext.volumeDir,
        available - megabytes(32),
        'destination storage'
      )
    ).rejects.toThrow(/including reserve/);

    // Room on the disk, and the reserve still free afterwards.
    await expect(
      guard.ensureStorageAvailable(
        envContext.volumeDir,
        available - megabytes(128),
        'destination storage'
      )
    ).resolves.toBeUndefined();
  });
});

describe('staying out of the way when it cannot know', () => {
  it('says nothing when the size of what is coming is unknown', async () => {
    const guard = await build();

    for (const unknown of [null, undefined, Number.NaN, -1]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        guard.ensureStorageAvailable(envContext.volumeDir, unknown, 'destination storage')
      ).resolves.toBeUndefined();
    }
  });

  // Refusing every upload on a filesystem we cannot measure would cost more
  // than the risk it avoids.
  it('says nothing when the filesystem cannot be measured', async () => {
    const guard = await build();
    const notADirectory = path.join(envContext.volumeDir, 'a-file');
    await fs.writeFile(notADirectory, 'x');
    const unmeasurable = path.join(notADirectory, 'under', 'a', 'file');

    expect(await guard.getAvailableBytes(unmeasurable)).toBeNull();
    await expect(
      guard.ensureStorageAvailable(unmeasurable, Number.MAX_SAFE_INTEGER, 'destination storage')
    ).resolves.toBeUndefined();
  });
});
