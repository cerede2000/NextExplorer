import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

let envContext;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'file-transfer-cancel-test-',
    env: { FOLDER_SIZE_MODE: 'off' },
    modules: [
      'src/services/fileTransferService',
      'src/services/folderSizeHooks',
      'src/config/env',
      'src/config/index',
      'src/services/accessManager',
      'src/services/users',
    ],
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

describe('Transfer cancellation', () => {
  it('removes the partial target and keeps the source when a copy is cancelled', async () => {
    const { executeTransfer } = envContext.requireFresh('src/services/fileTransferService');
    const sourceDir = path.join(envContext.tmpRoot, 'source');
    const destinationDir = path.join(envContext.tmpRoot, 'destination');
    const sourcePath = path.join(sourceDir, 'large.bin');
    const destinationPath = path.join(destinationDir, 'large.bin');

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(sourcePath, Buffer.alloc(4 * 1024 * 1024, 7));
    await fs.mkdir(destinationDir, { recursive: true });

    const controller = new AbortController();
    const prep = {
      destinationRelative: 'destination',
      destinationAbsolute: destinationDir,
      totalBytes: 4 * 1024 * 1024,
      plans: [
        {
          sourceAbsolute: sourcePath,
          sourceRelative: 'source/large.bin',
          isDirectory: false,
          size: 4 * 1024 * 1024,
          desiredName: 'large.bin',
        },
      ],
    };

    await expect(
      executeTransfer(
        prep,
        'copy',
        ({ copiedBytes }) => {
          if (copiedBytes > 0) controller.abort();
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

    await expect(fs.stat(sourcePath)).resolves.toMatchObject({ size: 4 * 1024 * 1024 });
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a copy before deleting its active destination directory', async () => {
    const { executeTransfer, deleteItems } = envContext.requireFresh(
      'src/services/fileTransferService'
    );
    const usersService = envContext.requireFresh('src/services/users');
    const user = await usersService.createLocalUser({
      email: 'transfer-delete@example.com',
      username: 'transfer-delete',
      displayName: 'Transfer Delete',
      password: 'secret123',
      roles: ['admin'],
    });
    const sourceDir = path.join(envContext.volumeDir, 'source');
    const destinationDir = path.join(envContext.volumeDir, 'destination');
    const sourcePath = path.join(sourceDir, 'active');
    const destinationPath = path.join(destinationDir, 'active');

    await fs.mkdir(sourcePath, { recursive: true });
    await fs.mkdir(destinationDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        fs.writeFile(
          path.join(sourcePath, `part-${index}.bin`),
          Buffer.alloc(8 * 1024 * 1024, index)
        )
      )
    );

    const prep = {
      destinationRelative: 'destination',
      destinationAbsolute: destinationDir,
      totalBytes: 32 * 1024 * 1024,
      plans: [
        {
          sourceAbsolute: sourcePath,
          sourceRelative: 'source/active',
          isDirectory: true,
          size: 32 * 1024 * 1024,
          desiredName: 'active',
        },
      ],
    };
    let deletion;
    const transfer = executeTransfer(prep, 'copy', ({ copiedBytes }) => {
      if (copiedBytes > 0 && !deletion) {
        deletion = deleteItems([{ path: 'destination', name: 'active', kind: 'directory' }], {
          user,
        });
      }
    });

    await expect(transfer).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    await expect(deletion).resolves.toMatchObject([
      { path: 'destination/active', status: 'deleted' },
    ]);
    await expect(fs.stat(sourcePath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/**
 * Removing a plain file used to fork `rm -rf` for it, on Linux only — which is
 * to say in the container. That is ~1.2 ms of process setup against ~0.06 ms
 * of actual work, so a two-thousand-file selection spent over two seconds
 * doing nothing but starting processes. A directory still earns its fork: the
 * recursion runs natively and killing the process cancels it.
 */
describe('Native removal', () => {
  it('never forks for a single file, even where the native path exists', async () => {
    const { shouldRemoveNatively } = await import('../../src/services/fileTransferService.js');

    // The flag is passed explicitly: it is false on anything but Linux, and a
    // test that only ever sees false would pass without checking anything.
    expect(shouldRemoveNatively(false, true)).toBe(false);
  });

  it('keeps the native path for directories', async () => {
    const { shouldRemoveNatively } = await import('../../src/services/fileTransferService.js');

    expect(shouldRemoveNatively(true, true)).toBe(true);
    expect(shouldRemoveNatively(true, false)).toBe(false);
  });
});
