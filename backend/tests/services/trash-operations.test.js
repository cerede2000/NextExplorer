import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});

describe('recovering a zone', () => {
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
