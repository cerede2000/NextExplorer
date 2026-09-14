import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import express from 'express';
import request from 'supertest';
import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A file's history follows the file — renamed, moved, into the trash and out
 * of it — and ends with it, however it ends.
 *
 * Every test ends on the oracle of every zone, which checks the versions and
 * the trash together: a history in the trash belongs to an item that is there,
 * no content is left without a version, no version without its content.
 */

const DAY = 24 * 60 * 60 * 1000;

let env;
let versionOperations;
let store;
let trashStore;
let trashOperations;
let zones;
let maintenance;
let failpoints;
let verify;
let clock;
let settingsService;
let db;

const load = (relative) => require(modulePath(relative));

// Rename goes through the route, as the application does it, so the version hook
// it wires in is what is exercised.
const renameThrough = async (parentRelative, currentName, newName) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = admin;
    next();
  });
  app.use('/api', load('src/routes/files/rename'));
  app.use(load('src/middleware/errorHandler').errorHandler);
  const response = await request(app)
    .post('/api/files/rename')
    .send({ path: parentRelative, name: currentName, newName });
  if (response.status !== 200)
    throw new Error(`rename failed: ${response.status} ${response.text}`);
};

const admin = { id: 'admin-1', username: 'admin', roles: ['admin'] };

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'versions-lifecycle-', env: { UPLOAD_STORAGE_RESERVE: '0' } });
  versionOperations = load('src/services/versions/operations');
  store = load('src/services/versions/store');
  trashStore = load('src/services/trash/store');
  trashOperations = load('src/services/trash/operations');
  zones = load('src/services/trash/zones');
  maintenance = load('src/services/trash/maintenance');
  failpoints = load('src/services/trash/failpoints');
  verify = load('src/services/trash/verify');
  clock = load('src/services/trash/clock');
  settingsService = load('src/services/settingsService');
  db = await load('src/services/db').getDb();
  await fs.mkdir(volume('Projects'), { recursive: true });
  await fs.mkdir(volume('Photos'), { recursive: true });
});

afterEach(async () => {
  failpoints.clear();
  maintenance.stop();
  vi.restoreAllMocks();
  await env.cleanup();
});

function volume(...segments) {
  return path.join(env.volumeDir, ...segments);
}

const write = async (relative, content) => {
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
};

const save = (relative, content) =>
  versionOperations.saveFile(volume(relative), (temporary) => fs.writeFile(temporary, content), {
    source: 'editor',
  });

/** A file whose history holds every content but the last, which it now has. */
const withHistory = async (relative, ...contents) => {
  await write(relative, contents[0]);
  for (const content of contents.slice(1)) {
    // eslint-disable-next-line no-await-in-loop
    await save(relative, content);
  }
};

const zoneAt = (volumeName) =>
  trashStore.listZones(db).find((zone) => zone.root === volume(volumeName));

const historyAt = (relative, states = ['live', 'orphaned', 'trashed']) => {
  const [volumeName, ...inside] = relative.split('/');
  const zone = zoneAt(volumeName);
  return zone ? store.findFileAt(db, zone.id, inside.join('/'), states) : null;
};

/** What a history keeps, newest first, read from wherever each version is stored. */
const keptContents = async (file) => {
  if (!file) return [];
  return Promise.all(
    store.listVersionsOfFile(db, file.id).map((version) => {
      const zone = trashStore.getZone(db, version.zoneId);
      return fs.readFile(path.join(zones.versionsDirectory(zone.root), version.id), 'utf8');
    })
  );
};

const expectConsistent = async () => {
  for (const zone of trashStore.listZones(db)) {
    // eslint-disable-next-line no-await-in-loop
    expect((await verify.verifyZone(zone)).violations).toEqual([]);
  }
};

const versionContentsIn = async (volumeName) => {
  const zone = zoneAt(volumeName);
  return zone ? fs.readdir(zones.versionsDirectory(zone.root)).catch(() => []) : [];
};

describe('a history follows its file', () => {
  it('through a rename', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');

    await renameThrough('Projects', 'report.txt', 'final.txt');

    expect(historyAt('Projects/report.txt')).toBeNull();
    expect(await keptContents(historyAt('Projects/final.txt'))).toEqual(['one']);
    await expectConsistent();
  });

  it('through the rename of the folder that holds it', async () => {
    await withHistory('Projects/client/brief.txt', 'draft', 'final');

    await renameThrough('Projects', 'client', 'customer');

    expect(await keptContents(historyAt('Projects/customer/brief.txt'))).toEqual(['draft']);
    await expectConsistent();
  });

  it('through a move to another volume, its versions staying where they were kept', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');
    await load('src/services/fileTransferService').transferItems(
      [{ path: 'Projects', name: 'report.txt' }],
      'Photos',
      'move',
      { user: admin }
    );

    const file = historyAt('Photos/report.txt');
    expect(file.zoneId).toBe(zoneAt('Photos').id);
    expect(store.listVersionsOfFile(db, file.id)[0].zoneId).toBe(zoneAt('Projects').id);
    expect(await keptContents(file)).toEqual(['one']);

    await save('Photos/report.txt', 'three');
    expect(await keptContents(historyAt('Photos/report.txt'))).toEqual(['two', 'one']);
    await expectConsistent();
  });

  it('but a copy starts with none', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');
    await load('src/services/fileTransferService').transferItems(
      [{ path: 'Projects', name: 'report.txt' }],
      'Photos',
      'copy',
      { user: admin }
    );

    expect(historyAt('Photos/report.txt')).toBeNull();
    expect(await keptContents(historyAt('Projects/report.txt'))).toEqual(['one']);
  });
});

describe('a history in the trash', () => {
  it('goes to the trash with its file, and comes back with it', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');

    const trashed = await trashOperations.moveToTrash({
      absolutePath: volume('Projects/report.txt'),
    });
    expect(historyAt('Projects/report.txt', ['trashed'])).toMatchObject({
      trashItemId: trashed.item.id,
      trashEntry: '',
    });
    await expectConsistent();

    expect((await trashOperations.restoreItem(trashed.item.id)).status).toBe('restored');
    expect(await keptContents(historyAt('Projects/report.txt', ['live']))).toEqual(['one']);
    await expectConsistent();
  });

  it('comes back under the name the restore gives when the old one is taken', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');
    const trashed = await trashOperations.moveToTrash({
      absolutePath: volume('Projects/report.txt'),
    });
    await write('Projects/report.txt', 'a new file');

    await trashOperations.restoreItem(trashed.item.id);

    expect(await keptContents(historyAt('Projects/report (1).txt', ['live']))).toEqual(['one']);
    expect(historyAt('Projects/report.txt')).toBeNull();
    await expectConsistent();
  });

  it('comes out of a deleted folder with its own entry, and only that one', async () => {
    await withHistory('Projects/client/a.txt', 'a1', 'a2');
    await withHistory('Projects/client/b.txt', 'b1', 'b2');
    const trashed = await trashOperations.moveToTrash({ absolutePath: volume('Projects/client') });

    await trashOperations.restoreEntry(trashed.item.id, 'a.txt');

    expect(await keptContents(historyAt('Projects/client/a.txt', ['live']))).toEqual(['a1']);
    expect(historyAt('Projects/client/b.txt', ['trashed'])).toMatchObject({ trashEntry: 'b.txt' });
    await expectConsistent();
  });

  it('follows a restore into a folder someone chose', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');
    const trashed = await trashOperations.moveToTrash({
      absolutePath: volume('Projects/report.txt'),
    });

    await trashOperations.restoreItem(trashed.item.id, { destinationDirectory: volume('Photos') });

    expect(await keptContents(historyAt('Photos/report.txt', ['live']))).toEqual(['one']);
    await expectConsistent();
  });

  it('goes for good, versions and all, when the item is purged', async () => {
    await withHistory('Projects/report.txt', 'one', 'two', 'three');
    const trashed = await trashOperations.moveToTrash({
      absolutePath: volume('Projects/report.txt'),
    });
    const file = historyAt('Projects/report.txt', ['trashed']);

    await trashOperations.purgeItem(trashed.item.id);

    expect(store.getFile(db, file.id)).toBeNull();
    expect(await versionContentsIn('Projects')).toEqual([]);
    await expectConsistent();
  });

  it('goes with an item whose record is forgotten, once its zone is seen again', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');
    const trashed = await trashOperations.moveToTrash({
      absolutePath: volume('Projects/report.txt'),
    });
    const file = historyAt('Projects/report.txt', ['trashed']);

    await trashOperations.forgetItem(trashed.item.id);
    expect(store.getFile(db, file.id).state).toBe('purging');
    await versionOperations.recoverZone(zoneAt('Projects'));

    expect(store.getFile(db, file.id)).toBeNull();
    expect(await versionContentsIn('Projects')).toEqual([]);
  });

  it.each([
    ['trash:after-rename', 'trash'],
    ['restore:after-rename', 'restore'],
    ['extract:after-rename', 'extract'],
  ])('ends where the content is after a crash at %s', async (point, operation) => {
    await withHistory('Projects/client/a.txt', 'a1', 'a2');
    let trashed = null;
    if (operation !== 'trash') {
      trashed = await trashOperations.moveToTrash({ absolutePath: volume('Projects/client') });
    }
    failpoints.set(point, () => failpoints.crash(point));

    const run = {
      trash: () => trashOperations.moveToTrash({ absolutePath: volume('Projects/client') }),
      restore: () => trashOperations.restoreItem(trashed.item.id),
      extract: () => trashOperations.restoreEntry(trashed.item.id, 'a.txt'),
    }[operation];
    await expect(run()).rejects.toMatchObject({ simulatedCrash: true });
    failpoints.clear();
    await trashOperations.recoverZone(zoneAt('Projects'));

    const expectedState = operation === 'trash' ? 'trashed' : 'live';
    const file = historyAt('Projects/client/a.txt', [expectedState]);
    expect(file?.state).toBe(expectedState);
    expect(await keptContents(file)).toEqual(['a1']);
    await expectConsistent();
  });
});

describe('a history deleted with its file', () => {
  it('goes at once, versions and all, when the file is deleted for good', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');
    const file = historyAt('Projects/report.txt');

    const [result] = await load('src/services/fileTransferService').deleteItems(
      [{ path: 'Projects', name: 'report.txt' }],
      { user: admin, permanent: true }
    );

    expect(result.status).toBe('deleted');
    expect(store.getFile(db, file.id)).toBeNull();
    expect(await versionContentsIn('Projects')).toEqual([]);
    await expectConsistent();
  });

  it('goes into the trash with a deletion that goes there', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');

    const [result] = await load('src/services/fileTransferService').deleteItems(
      [{ path: 'Projects', name: 'report.txt' }],
      { user: admin }
    );

    expect(result.status).toBe('trashed');
    expect(historyAt('Projects/report.txt', ['trashed']).trashItemId).toBe(result.trashItemId);
    await expectConsistent();
  });
});

describe('a file that disappears outside the application', () => {
  it('leaves its history orphaned, kept for the retention, then gone', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');
    await fs.rm(volume('Projects/report.txt'));

    await maintenance.runPass();
    const orphan = historyAt('Projects/report.txt', ['orphaned']);
    expect(orphan?.state).toBe('orphaned');
    expect(await keptContents(orphan)).toEqual(['one']);
    await expectConsistent();

    vi.spyOn(clock, 'now').mockReturnValue(Date.now() + 31 * DAY);
    await maintenance.runPass();

    expect(store.getFile(db, orphan.id)).toBeNull();
    expect(await versionContentsIn('Projects')).toEqual([]);
    await expectConsistent();
  });

  it('takes its history back when it reappears at the same path', async () => {
    await withHistory('Projects/report.txt', 'one', 'two');
    await fs.rm(volume('Projects/report.txt'));
    await maintenance.runPass();

    await write('Projects/report.txt', 'put back over SMB');
    await maintenance.runPass();

    expect(historyAt('Projects/report.txt', ['live'])).not.toBeNull();
    await save('Projects/report.txt', 'edited again');
    expect(await keptContents(historyAt('Projects/report.txt'))).toEqual([
      'put back over SMB',
      'one',
    ]);
    await expectConsistent();
  });

  it('orphans nothing when too many files vanish at once', async () => {
    for (let index = 0; index < 6; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await withHistory(`Projects/file-${index}.txt`, 'before', 'after');
    }
    for (let index = 0; index < 6; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await fs.rm(volume(`Projects/file-${index}.txt`));
    }

    await maintenance.runPass();

    expect(store.listFiles(db, { state: 'orphaned' })).toEqual([]);
    expect(store.listFiles(db, { state: 'live' })).toHaveLength(6);
  });
});

describe('the space a zone shares with the trash', () => {
  const HOUR = 60 * 60 * 1000;

  const datedHistory = async () => {
    const now = Date.now();
    await write('Projects/report.txt', 'version-01');
    await fs.utimes(
      volume('Projects/report.txt'),
      new Date(now - 2 * HOUR),
      new Date(now - 2 * HOUR)
    );
    await save('Projects/report.txt', 'version-02');
    await fs.utimes(volume('Projects/report.txt'), new Date(now - HOUR), new Date(now - HOUR));
    await save('Projects/report.txt', 'version-03');
  };

  it('gives older versions first, then the trash, keeping the latest version of each file', async () => {
    await datedHistory();
    await write('Projects/deleted.txt', 'trash-item');
    const trashed = await trashOperations.moveToTrash({
      absolutePath: volume('Projects/deleted.txt'),
    });
    // Ten percent of 250 bytes: room for 25, and the zone holds 30.
    vi.spyOn(maintenance, 'measureVolume').mockResolvedValue({ totalBytes: 250, freeBytes: 1e9 });

    await maintenance.runPass();

    expect(await keptContents(historyAt('Projects/report.txt'))).toEqual(['version-02']);
    expect(trashStore.getItem(db, trashed.item.id)).not.toBeNull();
    const kinds = trashStore
      .listEvents(db, { zoneId: zoneAt('Projects').id })
      .map((event) => event.kind);
    expect(kinds).toContain('version-evicted');
    await expectConsistent();
  });

  it('thins every history with the tiers in force, not only the one last saved', async () => {
    await datedHistory();
    await settingsService.setSystemSetting('system', 'versions', {
      ...settingsService.sanitizeVersions({}),
      maxPerFile: 1,
    });

    await maintenance.runPass();

    expect(await keptContents(historyAt('Projects/report.txt'))).toEqual(['version-02']);
    await expectConsistent();
  });

  it('makes room for an upload out of versions too', async () => {
    await datedHistory();
    vi.spyOn(maintenance, 'measureVolume').mockResolvedValue({ totalBytes: 1e9, freeBytes: 5 });

    const freed = await maintenance.makeRoom(volume('Projects'), 15);

    expect(freed).toBe(10);
    expect(await keptContents(historyAt('Projects/report.txt'))).toEqual(['version-02']);
  });
});
