import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';
import { NATIVE_RSYNC } from '../helpers/native-rsync.js';

const childProcess = require('node:child_process');

/**
 * Copies through the native engine, with rsync really running.
 *
 * FILE_TRANSFER_ENGINE is native on Linux, so rsync copies in nearly every
 * deployment. The other transfer suites pin the stream engine so they run
 * everywhere, and a Mac cannot run rsync the way the service asks for it, so
 * nothing proved that rsync copied anything, nor that a copy through it keeps
 * the rule that nothing already at the destination is replaced. CI requires
 * these (REQUIRE_NATIVE_RSYNC); elsewhere they skip, and say so.
 */

let currentEnv;

afterEach(async () => {
  vi.restoreAllMocks();
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const insertAdmin = async (env) => {
  const db = await env.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
  ).run(now, now);
  return { id: 'admin', roles: ['admin'] };
};

const setup = async () => {
  currentEnv = await setupTestEnv({
    tag: 'native-rsync-',
    env: { FILE_TRANSFER_ENGINE: 'native', FOLDER_SIZE_MODE: 'off' },
  });
  // What the service spawns, recorded, so a copy that silently fell back to the
  // in-application engine cannot pass for one rsync made.
  const commands = [];
  const spawn = childProcess.spawn;
  vi.spyOn(childProcess, 'spawn').mockImplementation(function recordSpawn(command, ...rest) {
    commands.push(command);
    return spawn.call(this, command, ...rest);
  });
  const service = currentEnv.requireFresh('src/services/fileTransferService');
  const user = await insertAdmin(currentEnv);
  return { service, volume: currentEnv.volumeDir, user, commands };
};

const runTransfer = async (service, items, destination, operation, { user } = {}) => {
  const prep = await service.prepareTransfer(items, destination, operation, { user });
  return service.executeTransfer(prep, operation, undefined, {});
};

const readTree = async (root) => {
  const tree = {};
  const walk = async (directory, prefix) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else tree[relative] = await fs.readFile(path.join(directory, entry.name), 'utf8');
    }
  };
  await walk(root, '');
  return tree;
};

describe.skipIf(!NATIVE_RSYNC)('a copy through rsync', () => {
  it('copies a folder whole, and leaves nothing else at the destination', async () => {
    const { service, volume, user, commands } = await setup();
    await fs.mkdir(path.join(volume, 'Source', 'Album', 'nested'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Source', 'Album', 'a.txt'), 'first');
    await fs.writeFile(path.join(volume, 'Source', 'Album', 'nested', 'b.txt'), 'second');
    await fs.mkdir(path.join(volume, 'Dest'), { recursive: true });

    await runTransfer(service, [{ path: 'Source', name: 'Album' }], 'Dest', 'copy', { user });

    expect(commands).toContain('rsync');
    expect(await fs.readdir(path.join(volume, 'Dest'))).toEqual(['Album']);
    expect(await readTree(path.join(volume, 'Dest', 'Album'))).toEqual({
      'a.txt': 'first',
      'nested/b.txt': 'second',
    });
  });

  it('copies a file beside one of the same name, leaving that one untouched', async () => {
    const { service, volume, user, commands } = await setup();
    await fs.mkdir(path.join(volume, 'Source'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Dest'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Source', 'note.txt'), 'the newcomer');
    await fs.writeFile(path.join(volume, 'Dest', 'note.txt'), 'the incumbent');

    const result = await runTransfer(
      service,
      [{ path: 'Source', name: 'note.txt' }],
      'Dest',
      'copy',
      {
        user,
      }
    );

    expect(commands).toContain('rsync');
    expect(result.items[0].to).toBe('Dest/note (1).txt');
    expect(await fs.readFile(path.join(volume, 'Dest', 'note.txt'), 'utf8')).toBe('the incumbent');
    expect(await fs.readFile(path.join(volume, 'Dest', 'note (1).txt'), 'utf8')).toBe(
      'the newcomer'
    );
    expect((await fs.readdir(path.join(volume, 'Dest'))).sort()).toEqual([
      'note (1).txt',
      'note.txt',
    ]);
  });
});
