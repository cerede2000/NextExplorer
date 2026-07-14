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
});
