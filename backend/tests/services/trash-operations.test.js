import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OTHER_DEVICE } from '../helpers/cross-device.js';
import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Putting things in the trash, taking them out, letting them go — and
 * surviving a crash at any step of it.
 *
 * Every test ends on the same oracle, `verifyZone`, which checks that the
 * zone's records and its disk agree. The crash tests stop each operation at
 * each of its step boundaries in turn, restart from nothing (as a process that
 * died would), run the recovery, and require two things: the oracle finds
 * nothing wrong, and the deleted content exists exactly once — where it was,
 * or in the trash with its record, never both and never neither.
 */

const fsp = require('fs/promises');

let envContext;
let operations;
let zones;
let store;
let failpoints;
let verify;
let db;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'trash-operations-' });
  zones = load('src/services/trash/zones');
  store = load('src/services/trash/store');
  failpoints = load('src/services/trash/failpoints');
  operations = load('src/services/trash/operations');
  verify = load('src/services/trash/verify');
  db = await load('src/services/db').getDb();
});

afterEach(async () => {
  failpoints.clear();
  vi.restoreAllMocks();
  await envContext.cleanup();
});

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const write = async (relative, content) => {
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
};

const exists = (absolutePath) =>
  fs.lstat(absolutePath).then(
    () => true,
    () => false
  );

const trash = (relative, options = {}) =>
  operations.moveToTrash(
    {
      absolutePath: volume(relative),
      logicalPath: relative,
      space: 'volume',
      deletedBy: 'user-1',
      deletedByLabel: 'alice',
    },
    options
  );

const zoneOf = (volumeName = 'Projects') =>
  store.listZones(db).find((zone) => zone.root === volume(volumeName));

const rowsOf = (zone) => store.listItemsByZone(db, zone.id);

const expectConsistent = async (zone) => {
  const result = await verify.verifyZone(zone);
  expect(result.violations).toEqual([]);
  return result;
};

/** Every file under a directory with its content, to compare a tree before and after. */
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

const writeTree = async () => {
  await write('Projects/client/brief.txt', 'the brief');
  await write('Projects/client/drafts/v1.txt', 'first draft');
  await write('Projects/client/drafts/v2.txt', 'second, longer draft');
};

describe('putting an entry in the trash', () => {
  it('moves a file by renaming it, without copying a byte', async () => {
    await write('Projects/report.txt', 'quarterly figures');
    const inode = (await fs.stat(volume('Projects/report.txt'))).ino;

    const result = await trash('Projects/report.txt');

    expect(result.status).toBe('trashed');
    expect(await exists(volume('Projects/report.txt'))).toBe(false);
    const { payload } = zones.itemPaths(volume('Projects'), result.item.id);
    expect((await fs.stat(payload)).ino).toBe(inode);
    expect(await fs.readFile(payload, 'utf8')).toBe('quarterly figures');
    await expectConsistent(zoneOf());
  });

  it('records what it was, where it was, who deleted it and its size', async () => {
    await write('Projects/a/report.txt', 'quarterly figures');

    const { item } = await trash('Projects/a/report.txt');

    expect(item).toMatchObject({
      state: 'trashed',
      name: 'report.txt',
      kind: 'file',
      size: 'quarterly figures'.length,
      originalPath: volume('Projects/a/report.txt'),
      relativePath: 'a/report.txt',
      logicalPath: 'Projects/a/report.txt',
      space: 'volume',
      deletedBy: 'user-1',
      deletedByLabel: 'alice',
    });
  });

  /** The zone describes itself, so a lost database can be rebuilt from it. */
  it('leaves a description of the item beside it', async () => {
    await write('Projects/report.txt', 'quarterly figures');

    const { item } = await trash('Projects/report.txt');

    const { sidecar } = zones.itemPaths(volume('Projects'), item.id);
    const described = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    expect(described).toMatchObject({
      id: item.id,
      name: 'report.txt',
      originalPath: volume('Projects/report.txt'),
      deletedBy: 'user-1',
    });
  });

  it('moves a whole folder as one item, measured to the byte', async () => {
    await writeTree();
    const before = await readTree(volume('Projects/client'));

    const { item } = await trash('Projects/client');

    expect(item.kind).toBe('directory');
    expect(item.size).toBe(
      'the brief'.length + 'first draft'.length + 'second, longer draft'.length
    );
    expect(await readTree(zones.itemPaths(volume('Projects'), item.id).payload)).toEqual(before);
    await expectConsistent(zoneOf());
  });

  it('refuses a volume itself', async () => {
    await write('Projects/report.txt', 'x');

    expect(await trash('Projects')).toEqual({ status: 'unavailable', reason: 'zone-root' });
    expect(await exists(volume('Projects/report.txt'))).toBe(true);
  });

  it('refuses a disk it cannot rename onto, before creating anything', async () => {
    await write('Projects/mount/report.txt', 'on another disk');
    vi.spyOn(zones, 'deviceOf').mockImplementation(async (target) =>
      target.includes('mount') ? 2 : 1
    );

    expect(await trash('Projects/mount/report.txt')).toEqual({
      status: 'unavailable',
      reason: 'other-device',
    });
    expect(await exists(volume('Projects/mount/report.txt'))).toBe(true);
    expect(await exists(zones.zoneDirectory(volume('Projects')))).toBe(false);
  });

  /** Two mount points of one filesystem share a device number, and still refuse a rename. */
  it('undoes everything when the rename is refused across mount points', async () => {
    await write('Projects/report.txt', 'still here');
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
    );

    expect(await trash('Projects/report.txt')).toEqual({
      status: 'unavailable',
      reason: 'other-device',
    });
    expect(await fs.readFile(volume('Projects/report.txt'), 'utf8')).toBe('still here');
    const zone = zoneOf();
    expect(rowsOf(zone)).toEqual([]);
    expect(await fs.readdir(zones.trashDirectory(zone.root))).toEqual([]);
  });

  it('says so when the entry has gone before it could be moved', async () => {
    await fs.mkdir(volume('Projects'), { recursive: true });

    expect(await trash('Projects/never-there.txt')).toEqual({ status: 'missing' });
  });

  /** Removed by someone else between the checks and the rename. */
  it('undoes everything when the entry vanishes at the moment of the rename', async () => {
    await write('Projects/report.txt', 'x');
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );

    expect(await trash('Projects/report.txt')).toEqual({ status: 'missing' });
    const zone = zoneOf();
    expect(rowsOf(zone)).toEqual([]);
    expect(await fs.readdir(zones.trashDirectory(zone.root))).toEqual([]);
  });

  it('refuses what is larger than the whole budget, and says how large', async () => {
    await write('Projects/big.bin', '0123456789');

    expect(await trash('Projects/big.bin', { budgetFor: async () => 4 })).toEqual({
      status: 'unavailable',
      reason: 'too-large',
      size: 10,
      budgetBytes: 4,
    });
    expect(await exists(volume('Projects/big.bin'))).toBe(true);
  });

  it('lets in what fits the budget', async () => {
    await write('Projects/small.bin', '0123');

    expect((await trash('Projects/small.bin', { budgetFor: async () => 4 })).status).toBe(
      'trashed'
    );
  });

  it('refuses a zone it cannot open, and leaves the entry where it is', async () => {
    await write('Projects/report.txt', 'still here');
    await fs.mkdir(zones.zoneDirectory(volume('Projects')), { recursive: true });
    await fs.writeFile(zones.markerPath(volume('Projects')), 'corrupt');

    expect(await trash('Projects/report.txt')).toEqual({
      status: 'unavailable',
      reason: 'zone-unwritable',
    });
    expect(await exists(volume('Projects/report.txt'))).toBe(true);
  });

  it('gives two entries of the same name two items', async () => {
    await write('Projects/a/report.txt', 'first');
    await write('Projects/b/report.txt', 'second');

    const first = await trash('Projects/a/report.txt');
    const second = await trash('Projects/b/report.txt');

    expect(first.item.id).not.toBe(second.item.id);
    expect(rowsOf(zoneOf())).toHaveLength(2);
    await expectConsistent(zoneOf());
  });
});

describe('restoring an item', () => {
  it('puts a file back where it was, as it was', async () => {
    await write('Projects/a/report.txt', 'quarterly figures');
    const { item } = await trash('Projects/a/report.txt');

    const result = await operations.restoreItem(item.id);

    expect(result).toMatchObject({
      status: 'restored',
      restorePath: volume('Projects/a/report.txt'),
      renamed: false,
    });
    expect(await fs.readFile(volume('Projects/a/report.txt'), 'utf8')).toBe('quarterly figures');
    expect(rowsOf(zoneOf())).toEqual([]);
    expect(await fs.readdir(zones.trashDirectory(volume('Projects')))).toEqual([]);
    await expectConsistent(zoneOf());
  });

  it('puts a folder back whole', async () => {
    await writeTree();
    const before = await readTree(volume('Projects/client'));
    const { item } = await trash('Projects/client');

    await operations.restoreItem(item.id);

    expect(await readTree(volume('Projects/client'))).toEqual(before);
  });

  it('recreates the folder it came from when that folder is gone too', async () => {
    await write('Projects/a/b/report.txt', 'deep');
    const { item } = await trash('Projects/a/b/report.txt');
    await fs.rm(volume('Projects/a'), { recursive: true });

    const result = await operations.restoreItem(item.id);

    expect(result.status).toBe('restored');
    expect(await fs.readFile(volume('Projects/a/b/report.txt'), 'utf8')).toBe('deep');
  });

  it('never replaces what has taken its name since: it takes a suffix', async () => {
    await write('Projects/report.txt', 'the deleted one');
    const { item } = await trash('Projects/report.txt');
    await write('Projects/report.txt', 'the new one');

    const result = await operations.restoreItem(item.id);

    expect(result).toMatchObject({ status: 'restored', renamed: true });
    expect(result.restorePath).toBe(volume('Projects/report (1).txt'));
    expect(await fs.readFile(volume('Projects/report.txt'), 'utf8')).toBe('the new one');
    expect(await fs.readFile(volume('Projects/report (1).txt'), 'utf8')).toBe('the deleted one');
  });

  it('stays in the trash when a file now stands where its folder was', async () => {
    await write('Projects/a/report.txt', 'kept safe');
    const { item } = await trash('Projects/a/report.txt');
    await fs.rm(volume('Projects/a'), { recursive: true });
    await write('Projects/a', 'a file named like the folder');

    expect(await operations.restoreItem(item.id)).toEqual({
      status: 'blocked',
      reason: 'destination-blocked',
    });
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  it('leaves an item of a zone that is not there untouched', async () => {
    await write('Projects/report.txt', 'kept safe');
    const { item } = await trash('Projects/report.txt');
    await fs.rm(zones.markerPath(volume('Projects')));

    expect(await operations.restoreItem(item.id)).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
    expect(store.getItem(db, item.id).state).toBe('trashed');
    expect(await exists(zones.itemPaths(volume('Projects'), item.id).payload)).toBe(true);
  });

  it('restores an item once, however many ask at the same time', async () => {
    await write('Projects/report.txt', 'once');
    const { item } = await trash('Projects/report.txt');

    const results = await Promise.all([
      operations.restoreItem(item.id),
      operations.restoreItem(item.id),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['busy', 'restored']);
    expect(await exists(volume('Projects/report (1).txt'))).toBe(false);
  });

  it('says so for an item that does not exist', async () => {
    expect(await operations.restoreItem('00000000-0000-0000-0000-000000000000')).toEqual({
      status: 'missing',
    });
  });
});

describe('letting an item go', () => {
  it('removes its content and its records', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');

    const result = await operations.purgeItem(item.id);

    expect(result.status).toBe('purged');
    expect(await fs.readdir(zones.trashDirectory(volume('Projects')))).toEqual([]);
    expect(store.getItem(db, item.id)).toBeNull();
    await expectConsistent(zoneOf());
  });

  /** An edited row must not be able to aim a removal outside the zone. */
  it('refuses to remove anything for an id that could point outside the zone', async () => {
    await write('Projects/victim.txt', 'must survive');
    await write('Projects/report.txt', 'x');
    const { item } = await trash('Projects/report.txt');
    const forged = '../../victim.txt';
    store.insertItem(db, { ...item, id: forged, state: 'trashed' });

    await expect(operations.purgeItem(forged)).rejects.toMatchObject({
      code: 'TRASH_ITEM_ID_INVALID',
    });
    expect(await fs.readFile(volume('Projects/victim.txt'), 'utf8')).toBe('must survive');
  });

  it('leaves an item of a zone that is not there untouched', async () => {
    await write('Projects/report.txt', 'kept safe');
    const { item } = await trash('Projects/report.txt');
    await fs.rm(zones.markerPath(volume('Projects')));

    expect(await operations.purgeItem(item.id)).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
    expect(await exists(zones.itemPaths(volume('Projects'), item.id).payload)).toBe(true);
  });
});

/**
 * A deleted folder is one item, whatever it holds. What is inside is found from
 * the folder's own record — its original path, then the path inside it — so
 * looking into it and taking one entry out need no record of their own.
 */
describe('inside a deleted folder', () => {
  const trashClient = async () => {
    await writeTree();
    return (await trash('Projects/client')).item;
  };
  const payloadOf = (item) => zones.itemPaths(volume('Projects'), item.id).payload;

  it('lists what it holds, folders first, with the size of each file', async () => {
    const item = await trashClient();

    const result = await operations.listEntries(item.id, '');

    expect(result.status).toBe('listed');
    expect(result.entries).toEqual([
      { name: 'drafts', kind: 'directory', size: null, modifiedAt: expect.any(String) },
      { name: 'brief.txt', kind: 'file', size: 'the brief'.length, modifiedAt: expect.any(String) },
    ]);
  });

  it('lists a folder inside it', async () => {
    const item = await trashClient();

    const result = await operations.listEntries(item.id, 'drafts');

    expect(result.entries.map((entry) => entry.name)).toEqual(['v1.txt', 'v2.txt']);
  });

  it('says a file is not a folder, and a path it does not hold is missing', async () => {
    const item = await trashClient();
    await write('Projects/single.txt', 'x');
    const { item: file } = await trash('Projects/single.txt');

    expect(await operations.listEntries(item.id, 'brief.txt')).toEqual({ status: 'not-directory' });
    expect(await operations.listEntries(item.id, 'nowhere')).toEqual({ status: 'missing' });
    expect(await operations.listEntries(file.id, '')).toEqual({ status: 'not-directory' });
  });

  it.each(['..', '../..', 'drafts/../..', '/etc', 'drafts//v1.txt', '.', 'drafts/.', 'a\0b', 42])(
    'refuses %j as a path, before looking at the disk',
    async (entryPath) => {
      const item = await trashClient();

      expect(await operations.listEntries(item.id, entryPath)).toEqual({ status: 'invalid-path' });
      expect(await operations.restoreEntry(item.id, entryPath)).toEqual({
        status: 'invalid-path',
      });
    }
  );

  /** A link inside a deleted folder is an entry, never a way out of it. */
  it('reaches nothing through a symbolic link inside it', async () => {
    await write('Elsewhere/secret.txt', 'not in the trash');
    await writeTree();
    await fs.symlink(volume('Elsewhere'), volume('Projects/client/link'));
    const { item } = await trash('Projects/client');

    const listed = await operations.listEntries(item.id, '');

    expect(listed.entries.find((entry) => entry.name === 'link')).toMatchObject({
      kind: 'symlink',
      size: null,
    });
    expect(await operations.listEntries(item.id, 'link')).toEqual({ status: 'not-directory' });
    expect(await operations.restoreEntry(item.id, 'link/secret.txt')).toEqual({
      status: 'missing',
    });
    expect(await fs.readFile(volume('Elsewhere/secret.txt'), 'utf8')).toBe('not in the trash');
    expect(await exists(volume('Projects/client'))).toBe(false);
  });

  it('puts one file back where it was inside the folder, and keeps the rest in the trash', async () => {
    const item = await trashClient();
    const inode = (await fs.stat(path.join(payloadOf(item), 'drafts/v2.txt'))).ino;

    const result = await operations.restoreEntry(item.id, 'drafts/v2.txt');

    expect(result).toMatchObject({
      status: 'restored',
      kind: 'file',
      size: 'second, longer draft'.length,
      restorePath: volume('Projects/client/drafts/v2.txt'),
      renamed: false,
    });
    // Renamed out, not copied.
    expect((await fs.stat(volume('Projects/client/drafts/v2.txt'))).ino).toBe(inode);
    expect(await readTree(volume('Projects/client'))).toEqual({
      'drafts/v2.txt': 'second, longer draft',
    });
    expect(await readTree(payloadOf(item))).toEqual({
      'brief.txt': 'the brief',
      'drafts/v1.txt': 'first draft',
    });
    expect(store.getItem(db, item.id)).toMatchObject({
      state: 'trashed',
      size: 'the brief'.length + 'first draft'.length,
    });
    await expectConsistent(zoneOf());
  });

  it('puts a folder from inside it back whole', async () => {
    const item = await trashClient();

    const result = await operations.restoreEntry(item.id, 'drafts');

    expect(result).toMatchObject({
      status: 'restored',
      kind: 'directory',
      size: 'first draft'.length + 'second, longer draft'.length,
    });
    expect(await readTree(volume('Projects/client'))).toEqual({
      'drafts/v1.txt': 'first draft',
      'drafts/v2.txt': 'second, longer draft',
    });
    expect(await readTree(payloadOf(item))).toEqual({ 'brief.txt': 'the brief' });
    await expectConsistent(zoneOf());
  });

  it('goes back into the folder when it exists again, beside what is there now', async () => {
    const item = await trashClient();
    await write('Projects/client/drafts/v3.txt', 'written since');

    await operations.restoreEntry(item.id, 'drafts/v1.txt');

    expect(await readTree(volume('Projects/client'))).toEqual({
      'drafts/v1.txt': 'first draft',
      'drafts/v3.txt': 'written since',
    });
  });

  it('never replaces what has taken its name since: it takes a suffix', async () => {
    const item = await trashClient();
    await write('Projects/client/brief.txt', 'the new brief');

    const result = await operations.restoreEntry(item.id, 'brief.txt');

    expect(result).toMatchObject({
      status: 'restored',
      renamed: true,
      restorePath: volume('Projects/client/brief (1).txt'),
    });
    expect(await fs.readFile(volume('Projects/client/brief.txt'), 'utf8')).toBe('the new brief');
    expect(await fs.readFile(volume('Projects/client/brief (1).txt'), 'utf8')).toBe('the brief');
  });

  it('stays in the trash when a file now stands where its folder was', async () => {
    const item = await trashClient();
    const before = await readTree(payloadOf(item));
    await write('Projects/client', 'a file named like the folder');

    expect(await operations.restoreEntry(item.id, 'drafts/v1.txt')).toEqual({
      status: 'blocked',
      reason: 'destination-blocked',
    });
    expect(await readTree(payloadOf(item))).toEqual(before);
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  /** A folder replaced by a link since the deletion must not send anything elsewhere. */
  it('refuses a destination a symbolic link would lead out of the volume, and creates nothing there', async () => {
    const item = await trashClient();
    await fs.mkdir(volume('Elsewhere'), { recursive: true });
    await fs.symlink(volume('Elsewhere'), volume('Projects/client'));

    expect(await operations.restoreEntry(item.id, 'drafts/v1.txt')).toEqual({
      status: 'blocked',
      reason: 'invalid-destination',
    });
    expect(await fs.readdir(volume('Elsewhere'))).toEqual([]);
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  it('refuses the same for a whole item', async () => {
    await write('Projects/a/report.txt', 'kept safe');
    const { item } = await trash('Projects/a/report.txt');
    await fs.rm(volume('Projects/a'), { recursive: true });
    await fs.mkdir(volume('Elsewhere'), { recursive: true });
    await fs.symlink(volume('Elsewhere'), volume('Projects/a'));

    expect(await operations.restoreItem(item.id)).toEqual({
      status: 'blocked',
      reason: 'invalid-destination',
    });
    expect(await fs.readdir(volume('Elsewhere'))).toEqual([]);
  });

  it('follows a link that stays inside the volume, as the folder it stands for', async () => {
    const item = await trashClient();
    await fs.mkdir(volume('Projects/archive'), { recursive: true });
    await fs.symlink(volume('Projects/archive'), volume('Projects/client'));

    const result = await operations.restoreEntry(item.id, 'brief.txt');

    expect(result.status).toBe('restored');
    expect(await fs.readFile(volume('Projects/archive/brief.txt'), 'utf8')).toBe('the brief');
  });

  it('says so for an entry the folder does not hold', async () => {
    const item = await trashClient();

    expect(await operations.restoreEntry(item.id, 'nowhere.txt')).toEqual({ status: 'missing' });
    expect(await operations.restoreEntry(item.id, 'brief.txt/inside')).toEqual({
      status: 'missing',
    });
    expect(await operations.restoreEntry(item.id, '')).toEqual({ status: 'invalid-path' });
    expect(await exists(volume('Projects/client'))).toBe(false);
  });

  it('leaves a folder of a zone that is not there untouched', async () => {
    const item = await trashClient();
    await fs.rm(zones.markerPath(volume('Projects')));

    expect(await operations.listEntries(item.id, '')).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
    expect(await operations.restoreEntry(item.id, 'brief.txt')).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
    expect(await exists(path.join(payloadOf(item), 'brief.txt'))).toBe(true);
  });

  it('takes one entry out of a folder at a time, however many ask at once', async () => {
    const item = await trashClient();

    const results = await Promise.all([
      operations.restoreEntry(item.id, 'brief.txt'),
      operations.restoreEntry(item.id, 'drafts/v1.txt'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['busy', 'restored']);
    await expectConsistent(zoneOf());
  });

  it('is not purged, nor restored whole, while an entry is on its way out', async () => {
    const item = await trashClient();
    const during = {};
    failpoints.set('extract:after-intent', async () => {
      during.purge = (await operations.purgeItem(item.id)).status;
      during.restore = (await operations.restoreItem(item.id)).status;
    });

    expect((await operations.restoreEntry(item.id, 'brief.txt')).status).toBe('restored');

    expect(during).toEqual({ purge: 'busy', restore: 'busy' });
    await expectConsistent(zoneOf());
  });

  it('can still be restored whole afterwards, with what is left', async () => {
    const item = await trashClient();
    await operations.restoreEntry(item.id, 'drafts/v2.txt');
    await fs.rm(volume('Projects/client'), { recursive: true });

    expect((await operations.restoreItem(item.id)).status).toBe('restored');

    expect(await readTree(volume('Projects/client'))).toEqual({
      'brief.txt': 'the brief',
      'drafts/v1.txt': 'first draft',
    });
    await expectConsistent(zoneOf());
  });
});

/** What a preview may read from the trash: files only, and never through a link. */
describe('reading a file in the trash', () => {
  it('finds a deleted file, and a file inside a deleted folder', async () => {
    await write('Projects/notes.txt', 'some notes');
    const { item: file } = await trash('Projects/notes.txt');
    await writeTree();
    const { item: folder } = await trash('Projects/client');

    expect(await operations.locateFile(file.id)).toMatchObject({
      status: 'found',
      size: 'some notes'.length,
      absolutePath: zones.itemPaths(volume('Projects'), file.id).payload,
    });
    const inner = await operations.locateFile(folder.id, 'drafts/v2.txt');
    expect(inner).toMatchObject({ status: 'found', size: 'second, longer draft'.length });
    expect(await fs.readFile(inner.absolutePath, 'utf8')).toBe('second, longer draft');
  });

  it('refuses a folder, a link, a path that climbs out, and what is not there', async () => {
    await write('Elsewhere/secret.txt', 'not in the trash');
    await writeTree();
    await fs.symlink(volume('Elsewhere/secret.txt'), volume('Projects/client/link.txt'));
    const { item } = await trash('Projects/client');

    expect(await operations.locateFile(item.id)).toEqual({ status: 'not-file' });
    expect(await operations.locateFile(item.id, 'drafts')).toEqual({ status: 'not-file' });
    expect(await operations.locateFile(item.id, 'link.txt')).toEqual({ status: 'not-file' });
    expect(await operations.locateFile(item.id, '../secret.txt')).toEqual({
      status: 'invalid-path',
    });
    expect(await operations.locateFile(item.id, 'nowhere.txt')).toEqual({ status: 'missing' });
    expect(await operations.locateFile('00000000-0000-0000-0000-000000000000')).toEqual({
      status: 'missing',
    });
  });

  it('reads nothing from a zone that is not there', async () => {
    await write('Projects/notes.txt', 'x');
    const { item } = await trash('Projects/notes.txt');
    await fs.rm(zones.markerPath(volume('Projects')));

    expect(await operations.locateFile(item.id)).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
  });
});

/**
 * Restoring into a folder someone chose. On the same disk it is the same
 * rename as putting something back; across disks a rename is impossible, so the
 * content is copied beside where it is going and the trash's copy only lets go
 * once that copy is whole.
 */
describe('restoring somewhere else', () => {
  const archive = (...segments) => volume('Archive', ...segments);
  const trashClient = async () => {
    await writeTree();
    return (await trash('Projects/client')).item;
  };
  const payloadOf = (item) => zones.itemPaths(volume('Projects'), item.id).payload;
  /** Every restore from here on sees a second disk. */
  const acrossDisks = () => vi.spyOn(zones, 'sameDevice').mockResolvedValue(false);
  const clientTree = {
    'brief.txt': 'the brief',
    'drafts/v1.txt': 'first draft',
    'drafts/v2.txt': 'second, longer draft',
  };
  const clientBytes = 'the brief'.length + 'first draft'.length + 'second, longer draft'.length;

  beforeEach(async () => {
    await fs.mkdir(archive(), { recursive: true });
  });

  it('puts a file in the chosen folder by renaming it, on the same disk', async () => {
    await write('Projects/a/report.txt', 'quarterly figures');
    const { item } = await trash('Projects/a/report.txt');
    const inode = (await fs.stat(payloadOf(item))).ino;

    const result = await operations.restoreItem(item.id, { destinationDirectory: archive() });

    expect(result).toMatchObject({
      status: 'restored',
      restorePath: archive('report.txt'),
      renamed: false,
    });
    expect((await fs.stat(archive('report.txt'))).ino).toBe(inode);
    expect(await exists(volume('Projects/a/report.txt'))).toBe(false);
    expect(store.getItem(db, item.id)).toBeNull();
    await expectConsistent(zoneOf());
  });

  it('puts an entry of a deleted folder in the chosen folder, and keeps the rest', async () => {
    const item = await trashClient();

    const result = await operations.restoreEntry(item.id, 'drafts', {
      destinationDirectory: archive(),
    });

    expect(result).toMatchObject({ status: 'restored', restorePath: archive('drafts') });
    expect(await readTree(archive())).toEqual({
      'drafts/v1.txt': 'first draft',
      'drafts/v2.txt': 'second, longer draft',
    });
    expect(await exists(volume('Projects/client'))).toBe(false);
    expect(await readTree(payloadOf(item))).toEqual({ 'brief.txt': 'the brief' });
    await expectConsistent(zoneOf());
  });

  it('copies across disks, and lets the trash’s copy go only once the copy is whole', async () => {
    const item = await trashClient();
    acrossDisks();
    let reported = 0;

    const result = await operations.restoreItem(item.id, {
      destinationDirectory: archive(),
      onBytes: (bytes) => {
        reported += bytes;
      },
    });

    expect(result).toMatchObject({ status: 'restored', restorePath: archive('client') });
    expect(await readTree(archive('client'))).toEqual(clientTree);
    expect(reported).toBe(clientBytes);
    // Nothing left in the trash, and no partial copy beside the destination.
    expect(await fs.readdir(archive())).toEqual(['client']);
    expect(await fs.readdir(zones.trashDirectory(volume('Projects')))).toEqual([]);
    expect(store.getItem(db, item.id)).toBeNull();
    await expectConsistent(zoneOf());
  });

  it('copies an entry of a deleted folder across disks, and measures what is left', async () => {
    const item = await trashClient();
    acrossDisks();

    const result = await operations.restoreEntry(item.id, 'drafts/v2.txt', {
      destinationDirectory: archive(),
    });

    expect(result).toMatchObject({
      status: 'restored',
      kind: 'file',
      restorePath: archive('v2.txt'),
    });
    expect(await fs.readdir(archive())).toEqual(['v2.txt']);
    expect(await readTree(payloadOf(item))).toEqual({
      'brief.txt': 'the brief',
      'drafts/v1.txt': 'first draft',
    });
    expect(store.getItem(db, item.id)).toMatchObject({
      state: 'trashed',
      size: 'the brief'.length + 'first draft'.length,
    });
    await expectConsistent(zoneOf());
  });

  it.each([
    ['on the same disk', false],
    ['across disks', true],
  ])(
    'never replaces what already has the name in the chosen folder, %s',
    async (_label, across) => {
      await write('Projects/report.txt', 'the deleted one');
      const { item } = await trash('Projects/report.txt');
      await write('Archive/report.txt', 'already there');
      if (across) acrossDisks();

      const result = await operations.restoreItem(item.id, { destinationDirectory: archive() });

      expect(result).toMatchObject({ renamed: true, restorePath: archive('report (1).txt') });
      expect(await fs.readFile(archive('report.txt'), 'utf8')).toBe('already there');
      expect(await fs.readFile(archive('report (1).txt'), 'utf8')).toBe('the deleted one');
    }
  );

  it('refuses a folder that is not there, a file, and anything inside a trash zone', async () => {
    const item = await trashClient();
    await write('Archive/file.txt', 'not a folder');
    await fs.symlink(zones.zoneDirectory(volume('Projects')), archive('into-zone'));
    const refused = { status: 'blocked', reason: 'invalid-destination' };

    for (const destinationDirectory of [
      archive('nowhere'),
      archive('file.txt'),
      zones.trashDirectory(volume('Projects')),
      archive('into-zone'),
    ]) {
      expect(await operations.restoreItem(item.id, { destinationDirectory })).toEqual(refused);
      expect(await operations.restoreEntry(item.id, 'brief.txt', { destinationDirectory })).toEqual(
        refused
      );
    }
    expect(await readTree(payloadOf(item))).toEqual(clientTree);
    await expectConsistent(zoneOf());
  });

  it('stays in the trash when a copy across disks is cancelled, and leaves nothing behind', async () => {
    const item = await trashClient();
    acrossDisks();
    const controller = new AbortController();

    const result = await operations.restoreItem(item.id, {
      destinationDirectory: archive(),
      signal: controller.signal,
      onBytes: () => controller.abort(),
    });

    expect(result).toEqual({ status: 'cancelled' });
    expect(await fs.readdir(archive())).toEqual([]);
    expect(await readTree(payloadOf(item))).toEqual(clientTree);
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  it('stays in the trash when a copy across disks fails, and leaves nothing behind', async () => {
    const item = await trashClient();
    acrossDisks();
    const transfers = load('src/services/fileTransferService');
    vi.spyOn(transfers, 'copyEntryWithProgress').mockImplementation(async (_source, staging) => {
      await fs.mkdir(staging, { recursive: true });
      await fs.writeFile(path.join(staging, 'half.txt'), 'half');
      throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    });

    await expect(
      operations.restoreItem(item.id, { destinationDirectory: archive() })
    ).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(await fs.readdir(archive())).toEqual([]);
    expect(await readTree(payloadOf(item))).toEqual(clientTree);
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  /**
   * In the container the copy is rsync, which reports a running total rather
   * than chunks. Counting those as chunks broke the progress there while every
   * test on a machine without a recent rsync passed.
   */
  it('counts the bytes of a copy that reports a running total, as rsync does', async () => {
    const item = await trashClient();
    acrossDisks();
    const transfers = load('src/services/fileTransferService');
    const copy = transfers.copyEntryWithProgress;
    vi.spyOn(transfers, 'copyEntryWithProgress').mockImplementation(
      async (source, staging, isDirectory, onProgress, signal) => {
        onProgress({ copiedBytes: 9, percent: 22 });
        onProgress({ copiedBytes: 9, percent: 22 });
        onProgress({ copiedBytes: clientBytes, percent: 100 });
        return copy(source, staging, isDirectory, undefined, signal);
      }
    );
    const reports = [];

    const result = await operations.restoreItem(item.id, {
      destinationDirectory: archive(),
      onBytes: (bytes) => reports.push(bytes),
    });

    expect(result.status).toBe('restored');
    expect(reports).toEqual([9, clientBytes - 9]);
  });

  /** Two mount points of one filesystem share a device number, and still refuse a rename. */
  it('copies when a rename it expected to work is refused across mount points', async () => {
    await write('Projects/report.txt', 'still here');
    const { item } = await trash('Projects/report.txt');
    // Whichever call moves the content refuses it, as the kernel does for a
    // link as much as for a rename: a file is linked out of the trash, so that
    // it never replaces what holds its destination.
    let refusedOnce = false;
    for (const method of ['rename', 'link']) {
      const original = fsp[method].bind(fsp);
      vi.spyOn(fsp, method).mockImplementation(async (from, to) => {
        if (!refusedOnce && from === payloadOf(item)) {
          refusedOnce = true;
          throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        }
        return original(from, to);
      });
    }

    const result = await operations.restoreItem(item.id, { destinationDirectory: archive() });

    expect(refusedOnce).toBe(true);
    expect(result.status).toBe('restored');
    expect(await fs.readFile(archive('report.txt'), 'utf8')).toBe('still here');
    await expectConsistent(zoneOf());
  });

  describe.skipIf(!OTHER_DEVICE)('with a real second disk', () => {
    it('copies a deleted folder onto it, whole, and empties the trash of it', async () => {
      const item = await trashClient();
      const destination = await fs.mkdtemp(path.join(OTHER_DEVICE, 'nextexplorer-restore-'));
      try {
        const result = await operations.restoreItem(item.id, { destinationDirectory: destination });

        expect(result.status).toBe('restored');
        expect(await readTree(path.join(destination, 'client'))).toEqual(clientTree);
        expect(await fs.readdir(zones.trashDirectory(volume('Projects')))).toEqual([]);
        await expectConsistent(zoneOf());
      } finally {
        await fs.rm(destination, { recursive: true, force: true });
      }
    });
  });
});

describe('a crash at any step', () => {
  const restart = () => {
    failpoints.clear();
    // A process that died holds no operation in flight.
    operations.inflight.clear();
  };

  const crashAt = (point) => failpoints.set(point, () => failpoints.crash(point));

  describe.each([
    ['a file', 'Projects/report.txt', async () => write('Projects/report.txt', 'the content')],
    ['a folder', 'Projects/client', writeTree],
  ])('while trashing %s', (_label, relative, prepare) => {
    it.each(['trash:after-row', 'trash:after-sidecar', 'trash:after-rename'])(
      'at %s leaves the content exactly once',
      async (point) => {
        await prepare();
        const before = (await fs.stat(volume(relative))).isDirectory()
          ? await readTree(volume(relative))
          : await fs.readFile(volume(relative), 'utf8');
        crashAt(point);

        await expect(trash(relative)).rejects.toMatchObject({ simulatedCrash: true });
        restart();
        const zone = zoneOf();
        await operations.recoverZone(zone);

        await expectConsistent(zone);
        const rows = rowsOf(zone);
        const stillThere = await exists(volume(relative));
        expect(rows).toHaveLength(stillThere ? 0 : 1);
        const content = stillThere
          ? volume(relative)
          : zones.itemPaths(zone.root, rows[0].id).payload;
        const after = (await fs.stat(content)).isDirectory()
          ? await readTree(content)
          : await fs.readFile(content, 'utf8');
        expect(after).toEqual(before);
        if (!stillThere)
          expect(rows[0]).toMatchObject({ state: 'trashed', originalPath: volume(relative) });
      }
    );
  });

  it.each(['restore:after-intent', 'restore:after-rename'])(
    'while restoring, at %s leaves the content exactly once',
    async (point) => {
      await write('Projects/report.txt', 'the content');
      const { item } = await trash('Projects/report.txt');
      crashAt(point);

      await expect(operations.restoreItem(item.id)).rejects.toMatchObject({ simulatedCrash: true });
      restart();
      const zone = zoneOf();
      await operations.recoverZone(zone);

      await expectConsistent(zone);
      const back = await exists(volume('Projects/report.txt'));
      expect(rowsOf(zone)).toHaveLength(back ? 0 : 1);
      const content = back
        ? volume('Projects/report.txt')
        : zones.itemPaths(zone.root, item.id).payload;
      expect(await fs.readFile(content, 'utf8')).toBe('the content');
    }
  );

  it.each(['purge:after-intent', 'purge:after-remove'])(
    'while purging, at %s finishes the purge',
    async (point) => {
      await writeTree();
      const { item } = await trash('Projects/client');
      crashAt(point);

      await expect(operations.purgeItem(item.id)).rejects.toMatchObject({ simulatedCrash: true });
      restart();
      const zone = zoneOf();
      await operations.recoverZone(zone);

      await expectConsistent(zone);
      expect(rowsOf(zone)).toEqual([]);
      expect(await fs.readdir(zones.trashDirectory(zone.root))).toEqual([]);
      expect(await exists(volume('Projects/client'))).toBe(false);
    }
  );

  it.each(['extract:after-intent', 'extract:after-rename'])(
    'while restoring from inside a folder, at %s leaves the entry exactly once and the size true',
    async (point) => {
      await writeTree();
      const { item } = await trash('Projects/client');
      crashAt(point);

      await expect(operations.restoreEntry(item.id, 'drafts/v2.txt')).rejects.toMatchObject({
        simulatedCrash: true,
      });
      restart();
      const zone = zoneOf();
      const report = await operations.recoverZone(zone);

      // The oracle measures: a size left from before the entry went would fail I8.
      await expectConsistent(zone);
      expect(report.finished).toBe(1);
      expect(store.getItem(db, item.id).state).toBe('trashed');
      const inside = path.join(zones.itemPaths(zone.root, item.id).payload, 'drafts/v2.txt');
      const back = await exists(volume('Projects/client/drafts/v2.txt'));
      expect(back).toBe(point === 'extract:after-rename');
      expect(await exists(inside)).toBe(!back);
      expect(
        await fs.readFile(back ? volume('Projects/client/drafts/v2.txt') : inside, 'utf8')
      ).toBe('second, longer draft');
    }
  );

  describe.each([
    ['a deleted folder', null],
    ['an entry of a deleted folder', 'drafts'],
  ])('while copying %s across disks', (_label, entryPath) => {
    const expectedTree = entryPath
      ? { 'v1.txt': 'first draft', 'v2.txt': 'second, longer draft' }
      : {
          'brief.txt': 'the brief',
          'drafts/v1.txt': 'first draft',
          'drafts/v2.txt': 'second, longer draft',
        };
    const landedName = entryPath || 'client';

    it.each([
      ['copy:after-intent', false],
      ['copy:after-copy', false],
      ['copy:after-mark', true],
      ['copy:after-rename', true],
      ['copy:after-remove', true],
    ])('at %s leaves the content exactly once, and no partial copy', async (point, lands) => {
      await writeTree();
      const { item } = await trash('Projects/client');
      await fs.mkdir(volume('Archive'), { recursive: true });
      vi.spyOn(zones, 'sameDevice').mockResolvedValue(false);
      crashAt(point);
      const options = { destinationDirectory: volume('Archive') };

      await expect(
        entryPath
          ? operations.restoreEntry(item.id, entryPath, options)
          : operations.restoreItem(item.id, options)
      ).rejects.toMatchObject({ simulatedCrash: true });
      restart();
      const zone = zoneOf();
      await operations.recoverZone(zone);

      await expectConsistent(zone);
      const payload = zones.itemPaths(zone.root, item.id).payload;
      expect(await fs.readdir(volume('Archive'))).toEqual(lands ? [landedName] : []);
      if (!lands) {
        expect(await readTree(entryPath ? path.join(payload, entryPath) : payload)).toEqual(
          expectedTree
        );
        expect(store.getItem(db, item.id).state).toBe('trashed');
      } else if (entryPath) {
        expect(await readTree(volume('Archive', landedName))).toEqual(expectedTree);
        expect(await readTree(payload)).toEqual({ 'brief.txt': 'the brief' });
        expect(store.getItem(db, item.id).state).toBe('trashed');
      } else {
        expect(await readTree(volume('Archive', landedName))).toEqual(expectedTree);
        expect(await exists(payload)).toBe(false);
        expect(rowsOf(zone)).toEqual([]);
      }
    });
  });
});

describe('recovering a zone', () => {
  const stopCopyOnceWhole = async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    await fs.mkdir(volume('Archive'), { recursive: true });
    vi.spyOn(zones, 'sameDevice').mockResolvedValue(false);
    failpoints.set('copy:after-mark', () => failpoints.crash('copy:after-mark'));
    await expect(
      operations.restoreItem(item.id, { destinationDirectory: volume('Archive') })
    ).rejects.toMatchObject({ simulatedCrash: true });
    failpoints.clear();
    operations.inflight.clear();
    return item;
  };

  it('finishes a restore across disks whose name was taken while it was stopped, with a suffix', async () => {
    const item = await stopCopyOnceWhole();
    await write('Archive/client', 'something else took the name');

    await operations.recoverZone(zoneOf());

    expect(await fs.readFile(volume('Archive/client'), 'utf8')).toBe(
      'something else took the name'
    );
    expect(await readTree(volume('Archive/client (1)'))).toEqual({
      'brief.txt': 'the brief',
      'drafts/v1.txt': 'first draft',
      'drafts/v2.txt': 'second, longer draft',
    });
    expect(store.getItem(db, item.id)).toBeNull();
    await expectConsistent(zoneOf());
  });

  it('keeps the trash’s copy when a whole copy vanished before it could be named', async () => {
    const item = await stopCopyOnceWhole();
    const staging = (await fs.readdir(volume('Archive'))).find((name) =>
      name.startsWith(operations.STAGING_PREFIX)
    );
    expect(staging).toBeDefined();
    await fs.rm(volume('Archive', staging), { recursive: true });

    await operations.recoverZone(zoneOf());

    expect(store.getItem(db, item.id).state).toBe('trashed');
    expect(await readTree(zones.itemPaths(volume('Projects'), item.id).payload)).toEqual({
      'brief.txt': 'the brief',
      'drafts/v1.txt': 'first draft',
      'drafts/v2.txt': 'second, longer draft',
    });
    await expectConsistent(zoneOf());
  });

  it('records the loss of a folder whose content vanished while an entry was coming out', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    store.setItemState(db, item.id, 'extracting', {
      restorePath: volume('Projects/client/brief.txt'),
    });
    await fs.rm(zones.itemPaths(volume('Projects'), item.id).payload, { recursive: true });

    const report = await operations.recoverZone(zoneOf());

    expect(report.lost).toBe(1);
    expect(store.getItem(db, item.id)).toBeNull();
    await expectConsistent(zoneOf());
  });

  /** A database restored from an older backup knows nothing of recent deletions. */
  it('adopts content it has no record of, from its description', async () => {
    await write('Projects/a/report.txt', 'deleted after the backup');
    const { item } = await trash('Projects/a/report.txt');
    store.deleteItem(db, item.id);

    const report = await operations.recoverZone(zoneOf());

    expect(report.adopted).toBe(1);
    expect(store.getItem(db, item.id)).toMatchObject({
      state: 'trashed',
      name: 'report.txt',
      originalPath: volume('Projects/a/report.txt'),
      deletedBy: 'user-1',
    });
    await expectConsistent(zoneOf());
    await operations.restoreItem(item.id);
    expect(await fs.readFile(volume('Projects/a/report.txt'), 'utf8')).toBe(
      'deleted after the backup'
    );
  });

  it('adopts content with no description too, under a name that says so, never deleting it', async () => {
    await write('Projects/report.txt', 'nameless');
    const { item } = await trash('Projects/report.txt');
    store.deleteItem(db, item.id);
    await fs.rm(zones.itemPaths(volume('Projects'), item.id).sidecar);

    await operations.recoverZone(zoneOf());

    const adopted = store.getItem(db, item.id);
    expect(adopted.name).toBe(`recovered-${item.id.slice(0, 8)}`);
    expect(adopted.originalPath).toBe(volume('Projects', adopted.name));
    const events = store.listEvents(db, { zoneId: zoneOf().id });
    expect(events.map((event) => event.kind)).toContain('adopted');
    await expectConsistent(zoneOf());
  });

  /** An edited description must not aim a restore outside the zone's tree. */
  it('does not believe a description that points outside the zone', async () => {
    await write('Projects/report.txt', 'x');
    const { item } = await trash('Projects/report.txt');
    store.deleteItem(db, item.id);
    const { sidecar } = zones.itemPaths(volume('Projects'), item.id);
    const described = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    await fs.writeFile(sidecar, JSON.stringify({ ...described, originalPath: '/etc/passwd' }));

    await operations.recoverZone(zoneOf());

    const adopted = store.getItem(db, item.id);
    expect(zones.isWithin(volume('Projects'), adopted.originalPath)).toBe(true);
    expect(adopted.originalPath).not.toBe('/etc/passwd');
  });

  it('drops a record whose content was removed by hand, and records the loss', async () => {
    await write('Projects/report.txt', 'x');
    const { item } = await trash('Projects/report.txt');
    await fs.rm(zones.itemPaths(volume('Projects'), item.id).payload);

    const report = await operations.recoverZone(zoneOf());

    expect(report.lost).toBe(1);
    expect(store.getItem(db, item.id)).toBeNull();
    expect(store.listEvents(db, { zoneId: zoneOf().id })[0]).toMatchObject({
      kind: 'lost',
      itemName: 'report.txt',
    });
    await expectConsistent(zoneOf());
  });

  /** Most of a zone vanishing at once is a zone that looks wrong, not a hundred losses. */
  it('drops nothing when too much has vanished at once, and says so', async () => {
    const ids = [];
    for (let index = 0; index < 10; index += 1) {
      await write(`Projects/file-${index}.txt`, `content ${index}`);
      ids.push((await trash(`Projects/file-${index}.txt`)).item.id);
    }
    for (const id of ids.slice(0, 6)) {
      await fs.rm(zones.itemPaths(volume('Projects'), id).payload);
    }

    const report = await operations.recoverZone(zoneOf());

    expect(report.breaker).toBe(true);
    expect(rowsOf(zoneOf())).toHaveLength(10);
    expect(store.listEvents(db, { zoneId: zoneOf().id })[0].kind).toBe('breaker');
  });

  it('does not touch a zone whose marker is missing', async () => {
    await write('Projects/report.txt', 'x');
    const { item } = await trash('Projects/report.txt');
    await fs.rm(zones.markerPath(volume('Projects')));
    await fs.rm(zones.itemPaths(volume('Projects'), item.id).payload);

    const report = await operations.recoverZone(zoneOf());

    expect(report).toMatchObject({ skipped: true, reason: 'missing' });
    expect(store.getItem(db, item.id)).not.toBeNull();
  });

  it('removes the description a finished operation left behind', async () => {
    await write('Projects/report.txt', 'x');
    const { item } = await trash('Projects/report.txt');
    await operations.restoreItem(item.id);
    const stray = zones.itemPaths(
      volume('Projects'),
      '11111111-2222-3333-4444-555555555555'
    ).sidecar;
    await fs.writeFile(stray, '{}');

    const report = await operations.recoverZone(zoneOf());

    expect(report.removedSidecars).toBe(1);
    expect(await exists(stray)).toBe(false);
  });

  it('leaves alone what the application did not put there', async () => {
    await write('Projects/report.txt', 'x');
    await trash('Projects/report.txt');
    const trashDirectory = zones.trashDirectory(volume('Projects'));
    await fs.writeFile(path.join(trashDirectory, '.DS_Store'), 'finder');

    const report = await operations.recoverZone(zoneOf());

    expect(report.adopted).toBe(0);
    expect(await exists(path.join(trashDirectory, '.DS_Store'))).toBe(true);
    await expectConsistent(zoneOf());
  });

  it('changes nothing when run twice', async () => {
    await writeTree();
    await trash('Projects/client');
    const zone = zoneOf();
    await operations.recoverZone(zone);
    const rows = rowsOf(zone);
    const names = (await fs.readdir(zones.trashDirectory(zone.root))).sort();

    await operations.recoverZone(zone);

    expect(rowsOf(zone)).toEqual(rows);
    expect((await fs.readdir(zones.trashDirectory(zone.root))).sort()).toEqual(names);
  });
});

/** An oracle that always answered "fine" would make every test above vacuous. */
describe('the oracle', () => {
  it('sees content that has gone', async () => {
    await write('Projects/report.txt', 'x');
    const { item } = await trash('Projects/report.txt');
    await fs.rm(zones.itemPaths(volume('Projects'), item.id).payload);

    const { violations } = await verify.verifyZone(zoneOf());

    expect(violations).toEqual([{ invariant: 'I1', itemId: item.id, detail: 'content missing' }]);
  });

  it('sees content with no record', async () => {
    await write('Projects/report.txt', 'x');
    const { item } = await trash('Projects/report.txt');
    store.deleteItem(db, item.id);

    const { violations } = await verify.verifyZone(zoneOf());

    expect(violations.map((violation) => violation.detail).sort()).toEqual([
      'content without an item',
      'description without an item',
    ]);
  });

  it('sees an item left in a passing state', async () => {
    await write('Projects/report.txt', 'x');
    const { item } = await trash('Projects/report.txt');
    store.setItemState(db, item.id, 'purging');

    const { violations } = await verify.verifyZone(zoneOf());

    expect(violations).toEqual([
      { invariant: 'I4', itemId: item.id, detail: 'left in state purging' },
    ]);
  });

  it('sees a recorded size that is not the size on disk', async () => {
    await write('Projects/report.txt', 'x');
    const { item } = await trash('Projects/report.txt');
    await fs.appendFile(zones.itemPaths(volume('Projects'), item.id).payload, 'more');

    const { violations } = await verify.verifyZone(zoneOf());

    expect(violations).toEqual([
      { invariant: 'I8', itemId: item.id, detail: 'recorded 1 bytes, found 5' },
    ]);
  });

  it('sees a zone over its budget or a volume under its floor', async () => {
    await write('Projects/report.txt', '0123456789');
    await trash('Projects/report.txt');

    const { violations } = await verify.verifyZone(zoneOf(), {
      budgetBytes: 5,
      freeBytes: 10,
      floorBytes: 64,
    });

    expect(violations.map((violation) => violation.invariant)).toEqual(['I5', 'I5']);
  });

  it('reports a zone that is not there as unavailable, not as broken', async () => {
    await write('Projects/report.txt', 'x');
    await trash('Projects/report.txt');
    await fs.rm(zones.markerPath(volume('Projects')));

    expect(await verify.verifyZone(zoneOf())).toMatchObject({
      available: false,
      reason: 'missing',
      violations: [],
    });
  });
});
