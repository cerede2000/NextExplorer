import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Where a copy or a move can lose or duplicate somebody's files.
 *
 * The transfer service has two jobs that a defect turns into data loss: it must
 * never write over something already at the destination, and a move must never
 * remove the source until the copy that replaces it is complete. Around those
 * sit the refusals that keep a folder from swallowing itself, the skip that
 * makes moving a thing onto its own shelf a no-op, and the authorization that
 * decides a caller may write where they are pointing at all. These exercise the
 * states a bug would reach, through the real service and real temporary
 * directories rather than assumptions about what it does.
 *
 * The engine is pinned to `stream` so the in-application copy — the one that
 * handles symbolic links, file modes and byte-by-byte progress — runs on every
 * machine, rather than only where the native `rsync` path is unavailable.
 */

let currentEnv;

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
    tag: 'file-transfer-conflicts-',
    env: { FILE_TRANSFER_ENGINE: 'stream', FOLDER_SIZE_MODE: 'off' },
  });
  const service = currentEnv.requireFresh('src/services/fileTransferService');
  const user = await insertAdmin(currentEnv);
  return { service, volume: currentEnv.volumeDir, user };
};

const exists = (target) =>
  fs.lstat(target).then(
    () => true,
    () => false
  );

/** Run a transfer end to end, the way the route does: prepare, then execute. */
const runTransfer = async (service, items, destination, operation, options = {}) => {
  const { user, onProgress, signal } = options;
  const prep = await service.prepareTransfer(items, destination, operation, { user });
  return service.executeTransfer(prep, operation, onProgress, { signal });
};

afterEach(async () => {
  vi.restoreAllMocks();
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

describe('choosing a name at the destination', () => {
  it('suffixes a copy whose name is already taken and leaves the existing file untouched', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Source'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Dest'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Source', 'note.txt'), 'the newcomer');
    await fs.writeFile(path.join(volume, 'Dest', 'note.txt'), 'the incumbent');

    const result = await runTransfer(
      service,
      [{ path: 'Source', name: 'note.txt' }],
      'Dest',
      'copy',
      { user }
    );

    // The file that was already there keeps its name and its contents.
    expect(await fs.readFile(path.join(volume, 'Dest', 'note.txt'), 'utf8')).toBe('the incumbent');
    // The copy lands beside it under a suffixed name, so nothing is overwritten.
    expect(result.items[0].to).toBe('Dest/note (1).txt');
    expect(await fs.readFile(path.join(volume, 'Dest', 'note (1).txt'), 'utf8')).toBe(
      'the newcomer'
    );
  });

  it('duplicates a copy into the source folder itself rather than skipping it', async () => {
    // A move onto its own shelf is a no-op; a copy is a genuine duplicate. The
    // two must not be conflated — the skip belongs to move alone.
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Here'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Here', 'file.txt'), 'body');

    const result = await runTransfer(
      service,
      [{ path: 'Here', name: 'file.txt' }],
      'Here',
      'copy',
      { user }
    );

    expect(result.items[0].skipped).toBeUndefined();
    expect(result.items[0].to).toBe('Here/file (1).txt');
    expect((await fs.readdir(path.join(volume, 'Here'))).sort()).toEqual([
      'file (1).txt',
      'file.txt',
    ]);
  });
});

describe('a folder that would contain itself', () => {
  it('refuses to copy a folder into one of its own subfolders, and says why', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Nvm', 'Tree', 'inner'), { recursive: true });

    await expect(
      service.prepareTransfer([{ path: 'Nvm', name: 'Tree' }], 'Nvm/Tree/inner', 'copy', { user })
    ).rejects.toThrow(/into itself/i);
  });

  it('refuses to move a folder into one of its own subfolders', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Nvm', 'Tree', 'inner'), { recursive: true });

    await expect(
      service.prepareTransfer([{ path: 'Nvm', name: 'Tree' }], 'Nvm/Tree/inner', 'move', { user })
    ).rejects.toThrow(/into itself/i);
    // Nothing was moved: the folder and its subfolder are both still there.
    expect(await exists(path.join(volume, 'Nvm', 'Tree', 'inner'))).toBe(true);
  });

  it('refuses when the destination is the folder itself', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Nvm', 'Solo'), { recursive: true });

    await expect(
      service.prepareTransfer([{ path: 'Nvm', name: 'Solo' }], 'Nvm/Solo', 'copy', { user })
    ).rejects.toThrow(/into itself/i);
  });
});

describe('a move onto the place it already is', () => {
  it('skips a move whose destination is the source folder, leaving the file exactly where it was', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Shelf'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Shelf', 'keep.txt'), 'unchanged');

    const result = await runTransfer(
      service,
      [{ path: 'Shelf', name: 'keep.txt' }],
      'Shelf',
      'move',
      { user }
    );

    expect(result.items[0]).toMatchObject({ skipped: true });
    // The file is neither moved nor duplicated: one file, same contents.
    expect(await fs.readdir(path.join(volume, 'Shelf'))).toEqual(['keep.txt']);
    expect(await fs.readFile(path.join(volume, 'Shelf', 'keep.txt'), 'utf8')).toBe('unchanged');
  });
});

describe('a move across devices', () => {
  // A same-filesystem move is an atomic rename. When the destination is on
  // another device the rename fails with EXDEV and the move becomes a copy
  // followed by a deletion of the source. That fallback is the one that can
  // lose data, so it is forced here by making the move's own rename, or link
  // for a file, report EXDEV. Only those: the copy it falls back to is written
  // under a hidden name and put in place the same way, on one device.
  const forceCrossDevice = (movedFrom) => {
    const fsp = require('fs/promises');
    const crossDevice = () => {
      const error = new Error('cross-device link not permitted');
      error.code = 'EXDEV';
      return error;
    };
    for (const method of ['rename', 'link']) {
      const real = fsp[method].bind(fsp);
      vi.spyOn(fsp, method).mockImplementation(async (from, to) => {
        if (from !== movedFrom) return real(from, to);
        throw crossDevice();
      });
    }
  };

  it('copies the entry across and only then removes the source', async () => {
    const { service, volume, user } = await setup();
    forceCrossDevice(path.join(volume, 'From', 'payload.bin'));
    await fs.mkdir(path.join(volume, 'From'), { recursive: true });
    await fs.mkdir(path.join(volume, 'To'), { recursive: true });
    await fs.writeFile(path.join(volume, 'From', 'payload.bin'), 'the only copy');

    const result = await runTransfer(
      service,
      [{ path: 'From', name: 'payload.bin' }],
      'To',
      'move',
      { user }
    );

    expect(result.items[0]).toMatchObject({ from: 'From/payload.bin', to: 'To/payload.bin' });
    expect(await fs.readFile(path.join(volume, 'To', 'payload.bin'), 'utf8')).toBe('the only copy');
    // The source is gone only because the copy is complete.
    expect(await exists(path.join(volume, 'From', 'payload.bin'))).toBe(false);
  });

  it('leaves the source whole and removes the half-written destination when cancelled mid-copy', async () => {
    const { service, volume, user } = await setup();
    forceCrossDevice(path.join(volume, 'From', 'big'));
    await fs.mkdir(path.join(volume, 'From', 'big'), { recursive: true });
    await fs.mkdir(path.join(volume, 'To'), { recursive: true });
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        fs.writeFile(
          path.join(volume, 'From', 'big', `part-${index}.bin`),
          Buffer.alloc(2 * 1024 * 1024, index)
        )
      )
    );

    const controller = new AbortController();
    await expect(
      runTransfer(service, [{ path: 'From', name: 'big' }], 'To', 'move', {
        user,
        signal: controller.signal,
        onProgress: ({ copiedBytes }) => {
          if (copiedBytes > 0) controller.abort();
        },
      })
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

    // The move never got as far as deleting the source, and the partial copy
    // was cleaned up: the only intact copy of the folder is the original.
    expect(await exists(path.join(volume, 'From', 'big', 'part-0.bin'))).toBe(true);
    expect(await exists(path.join(volume, 'To', 'big'))).toBe(false);
  });
});

describe('copying the contents of a folder with the in-application engine', () => {
  it('copies a symbolic link inside a folder as a link, not as the file it points at', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Nvm', 'Linked'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Nvm', 'Dest'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Nvm', 'Linked', 'target.txt'), 'real contents');
    await fs.symlink('target.txt', path.join(volume, 'Nvm', 'Linked', 'alias.txt'));

    await runTransfer(service, [{ path: 'Nvm', name: 'Linked' }], 'Nvm/Dest', 'copy', { user });

    const copiedAlias = await fs.lstat(path.join(volume, 'Nvm', 'Dest', 'Linked', 'alias.txt'));
    expect(copiedAlias.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(volume, 'Nvm', 'Dest', 'Linked', 'alias.txt'))).toBe(
      'target.txt'
    );
  });

  it('preserves the mode of a copied file', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Bin'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Dest'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Bin', 'run.sh'), '#!/bin/sh\necho hi\n');
    await fs.chmod(path.join(volume, 'Bin', 'run.sh'), 0o750);

    await runTransfer(service, [{ path: 'Bin', name: 'run.sh' }], 'Dest', 'copy', { user });

    const copied = await fs.lstat(path.join(volume, 'Dest', 'run.sh'));
    expect(copied.mode & 0o777).toBe(0o750);
  });
});

describe('reporting how much has been copied', () => {
  it('reports a byte count that climbs to the size of the whole tree', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Nvm', 'Payload', 'nested'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Nvm', 'Dest'), { recursive: true });
    const first = Buffer.alloc(3 * 1024 * 1024, 1);
    const second = Buffer.alloc(2 * 1024 * 1024, 2);
    await fs.writeFile(path.join(volume, 'Nvm', 'Payload', 'a.bin'), first);
    await fs.writeFile(path.join(volume, 'Nvm', 'Payload', 'nested', 'b.bin'), second);
    const treeBytes = first.length + second.length;

    const observed = [];
    await runTransfer(service, [{ path: 'Nvm', name: 'Payload' }], 'Nvm/Dest', 'copy', {
      user,
      onProgress: ({ copiedBytes }) => observed.push(copiedBytes),
    });

    expect(observed.length).toBeGreaterThan(0);
    // Never runs backwards, and finishes reporting exactly what was copied.
    expect(observed).toEqual([...observed].sort((a, b) => a - b));
    expect(Math.max(...observed)).toBe(treeBytes);
  });
});

describe('cancelling part-way through a selection', () => {
  it('keeps the entries already finished and removes only the one in flight', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Src'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Dest'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Src', 'done.txt'), 'finished first');
    await fs.writeFile(path.join(volume, 'Src', 'big.bin'), Buffer.alloc(8 * 1024 * 1024, 9));

    const controller = new AbortController();
    await expect(
      runTransfer(
        service,
        [
          { path: 'Src', name: 'done.txt' },
          { path: 'Src', name: 'big.bin' },
        ],
        'Dest',
        'copy',
        {
          user,
          signal: controller.signal,
          onProgress: ({ currentName }) => {
            // The first entry is processed to completion before the second is
            // named; abort the moment the second one begins.
            if (currentName === 'big.bin') controller.abort();
          },
        }
      )
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

    // The completed entry survives; the interrupted one is removed, not left half-written.
    expect(await fs.readFile(path.join(volume, 'Dest', 'done.txt'), 'utf8')).toBe('finished first');
    expect(await exists(path.join(volume, 'Dest', 'big.bin'))).toBe(false);
    // Both sources are untouched by a copy.
    expect(await exists(path.join(volume, 'Src', 'done.txt'))).toBe(true);
    expect(await exists(path.join(volume, 'Src', 'big.bin'))).toBe(true);
  });
});

describe('authorization at the source and the destination', () => {
  const setupWithAcl = async (rules) => {
    currentEnv = await setupTestEnv({
      tag: 'file-transfer-acl-',
      env: { FILE_TRANSFER_ENGINE: 'stream', FOLDER_SIZE_MODE: 'off' },
    });
    const accessControl = currentEnv.requireFresh('src/services/accessControlService');
    await accessControl.setRules(rules);
    const service = currentEnv.requireFresh('src/services/fileTransferService');
    const db = await currentEnv.requireFresh('src/services/db').getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES ('user', 'user@example.com', 1, 'user', 'User', '["user"]', ?, ?)`
    ).run(now, now);
    return { service, volume: currentEnv.volumeDir, user: { id: 'user', roles: ['user'] } };
  };

  it('refuses to move a file out of a read-only folder, saying why rather than only that it failed', async () => {
    const { service, volume, user } = await setupWithAcl([
      { path: '/Locked', permissions: 'ro', recursive: true },
    ]);
    await fs.mkdir(path.join(volume, 'Locked'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Open'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Locked', 'note.txt'), 'read only');

    await expect(
      service.prepareTransfer([{ path: 'Locked', name: 'note.txt' }], 'Open', 'move', { user })
    ).rejects.toThrow(/move items from this path/i);
    // The file stays put: a refused move must not have removed the source.
    expect(await exists(path.join(volume, 'Locked', 'note.txt'))).toBe(true);
  });

  it('refuses to copy into a read-only destination, saying why', async () => {
    const { service, volume, user } = await setupWithAcl([
      { path: '/Locked', permissions: 'ro', recursive: true },
    ]);
    await fs.mkdir(path.join(volume, 'Locked'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Open'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Open', 'note.txt'), 'contents');

    await expect(
      service.prepareTransfer([{ path: 'Open', name: 'note.txt' }], 'Locked', 'copy', { user })
    ).rejects.toThrow(/create items in the destination/i);
    expect(await exists(path.join(volume, 'Locked', 'note.txt'))).toBe(false);
  });

  it('refuses to copy a folder into a place where folders may be made but files may not', async () => {
    // A copied folder carries files, so the folder-creation right alone must not
    // become a way past the file-creation restriction. The share hands out one
    // without the other.
    currentEnv = await setupTestEnv({
      tag: 'file-transfer-share-',
      env: { FILE_TRANSFER_ENGINE: 'stream', FOLDER_SIZE_MODE: 'off' },
    });
    const service = currentEnv.requireFresh('src/services/fileTransferService');
    const sharesService = currentEnv.requireFresh('src/services/sharesService');
    const db = await currentEnv.requireFresh('src/services/db').getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES ('owner', 'owner@example.com', 1, 'owner', 'Owner', '["admin"]', ?, ?)`
    ).run(now, now);

    const volume = currentEnv.volumeDir;
    await fs.mkdir(path.join(volume, 'Space', 'folder', 'inside'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Space', 'folder', 'inside', 'child.txt'), 'child');

    const share = await sharesService.createShare({
      ownerId: 'owner',
      sourceSpace: 'volume',
      sourcePath: 'Space',
      isDirectory: true,
      accessMode: 'readwrite',
      allowCreateFolder: true,
      allowCreateFile: false,
      sharingType: 'anyone',
    });
    const guestSession = { shareId: share.id };
    const token = share.shareToken;

    await expect(
      service.prepareTransfer(
        [{ path: `share/${token}`, name: 'folder' }],
        `share/${token}`,
        'copy',
        { guestSession }
      )
    ).rejects.toThrow(/create files in the destination/i);
  });
});

describe('the reserved trash zone', () => {
  it('refuses the .nextexplorer zone as a destination', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Vol', '.nextexplorer'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Vol', 'file.txt'), 'contents');

    await expect(
      service.prepareTransfer([{ path: 'Vol', name: 'file.txt' }], 'Vol/.nextexplorer', 'copy', {
        user,
      })
    ).rejects.toThrow(/reserved by the application/i);
  });

  it('refuses a path inside the .nextexplorer zone as a source', async () => {
    const { service, volume, user } = await setup();
    await fs.mkdir(path.join(volume, 'Vol', '.nextexplorer', 'trash'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Dest'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Vol', '.nextexplorer', 'trash', 'buried.txt'), 'hidden');

    await expect(
      service.prepareTransfer(
        [{ path: 'Vol/.nextexplorer/trash', name: 'buried.txt' }],
        'Dest',
        'copy',
        { user }
      )
    ).rejects.toThrow(/reserved by the application/i);
  });
});
