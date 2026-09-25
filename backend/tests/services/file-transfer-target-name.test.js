import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The name a copied or moved item lands under.
 *
 * Authorization is decided for the destination folder, and the item's name is
 * then joined onto it. That name came from the request as it was: `../x`
 * wrote beside or above the destination — into a folder the caller may only
 * read, or out of a share into the volume. A new name has to be a name; without one, the item
 * keeps the name it has on disk, not the one the request spelled.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const REGULAR = { id: 'regular', roles: ['user'] };

const setup = async () => {
  currentEnv = await setupTestEnv({
    tag: 'file-transfer-target-name-',
  });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('regular', 'regular@example.com', 1, 'regular', 'Regular', '["user"]', ?, ?)`
  ).run(now, now);

  const volume = currentEnv.volumeDir;
  await fs.mkdir(path.join(volume, 'Vol', 'drop'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Vol', 'drop', 'mine.txt'), 'mine');
  await fs.writeFile(path.join(volume, 'Vol', 'readme.txt'), 'read only');
  // The drop folder may be written; the rest of the volume folder only read.
  await currentEnv.requireFresh('src/services/accessControlService').setRules([
    { path: 'Vol/drop', recursive: true, permissions: 'rw' },
    { path: 'Vol', recursive: true, permissions: 'ro' },
  ]);

  const service = currentEnv.requireFresh('src/services/fileTransferService');
  return { service, volume };
};

const run = (service, items, destination) =>
  service.transferItems(items, destination, 'copy', { user: REGULAR });

describe('a new name for the copy', () => {
  it('is refused when it climbs out of the destination, and nothing lands above it', async () => {
    const { service, volume } = await setup();

    await expect(
      run(service, [{ path: 'Vol/drop', name: 'mine.txt', newName: '../planted.txt' }], 'Vol/drop')
    ).rejects.toThrow(/path separators/i);

    expect((await fs.readdir(path.join(volume, 'Vol'))).sort()).toEqual(['drop', 'readme.txt']);
  });

  it('is taken when it is a name', async () => {
    const { service, volume } = await setup();

    const result = await run(
      service,
      [{ path: 'Vol/drop', name: 'mine.txt', newName: 'copy of mine.txt' }],
      'Vol/drop'
    );

    expect(result.items[0].to).toBe('Vol/drop/copy of mine.txt');
    expect(await fs.readFile(path.join(volume, 'Vol', 'drop', 'copy of mine.txt'), 'utf8')).toBe(
      'mine'
    );
  });
});

describe('an item named with a way out in its name', () => {
  it('lands inside the destination under the name it has on disk', async () => {
    const { service, volume } = await setup();

    // `Vol/drop` + `../readme.txt` is the readable `Vol/readme.txt`: the source
    // is fine, but its spelling must not become the destination name.
    const result = await run(service, [{ path: 'Vol/drop', name: '../readme.txt' }], 'Vol/drop');

    expect(result.items[0].to).toBe('Vol/drop/readme.txt');
    expect(await fs.readFile(path.join(volume, 'Vol', 'drop', 'readme.txt'), 'utf8')).toBe(
      'read only'
    );
    expect((await fs.readdir(path.join(volume, 'Vol'))).sort()).toEqual(['drop', 'readme.txt']);
  });
});
