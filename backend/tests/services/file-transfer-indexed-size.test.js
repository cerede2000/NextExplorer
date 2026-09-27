import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What a copy of a folder announces it will copy, when folder sizes are on.
 *
 * The total a transfer reports progress against comes from the folder-size
 * index rather than a walk of the folder, which is the point of having one: a
 * folder of a million files is not read twice, once to count it. The index is
 * a database of its own, so this is also where a transfer asking the wrong
 * database would show — not as a wrong total, but as a copy that fails before
 * it starts, on a table that is not there.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const ADMIN = { id: 'admin', roles: ['admin'] };

const setup = async () => {
  currentEnv = await setupTestEnv({
    tag: 'file-transfer-indexed-size-',
    env: { FILE_TRANSFER_ENGINE: 'stream', FOLDER_SIZE_MODE: 'full' },
  });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
  ).run(now, now);

  const volume = currentEnv.volumeDir;
  await fs.mkdir(path.join(volume, 'Vol', 'Big'), { recursive: true });
  await fs.mkdir(path.join(volume, 'Vol', 'Dest'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Vol', 'Big', 'payload.bin'), Buffer.alloc(10));

  // The index and its helpers before the service, so that the service is
  // loaded against these instances and this connection.
  const index = await currentEnv.requireFresh('src/services/indexDb').getIndexDb();
  const folderSizeIndex = currentEnv.requireFresh('src/services/folderSizeIndex');
  const scope = currentEnv.requireFresh('src/services/folderSizeIndexer').getVolumeScope();
  const service = currentEnv.requireFresh('src/services/fileTransferService');
  return { service, index, folderSizeIndex, scope, volume, now };
};

describe('copying a folder whose size is indexed', () => {
  it('announces the size the index holds, and copies', async () => {
    const { service, index, folderSizeIndex, scope, volume, now } = await setup();
    // Deliberately not the size on disk: a total of 7777 can only have been
    // read from the index.
    folderSizeIndex.upsertScanEntry(index, scope, {
      absolutePath: path.join(volume, 'Vol', 'Big'),
      sizeBytes: 7777,
      entryCount: 1,
      lastFullScanAt: now,
    });

    const prep = await service.prepareTransfer([{ path: 'Vol', name: 'Big' }], 'Vol/Dest', 'copy', {
      user: ADMIN,
    });
    expect(prep.totalBytes).toBe(7777);

    await service.executeTransfer(prep, 'copy', undefined, {});
    expect(await fs.readdir(path.join(volume, 'Vol', 'Dest', 'Big'))).toEqual(['payload.bin']);
  });
});
