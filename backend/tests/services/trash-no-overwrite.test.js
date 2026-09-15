import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Taking something out of the trash never replaces what holds its name.
 *
 * A restore chose a free name, checked it once more, then renamed the content
 * there — and rename(2) replaces a file, or an empty folder, that appeared in
 * between. The move now takes the name with an operation that fails when it is
 * held (`moveNoReplace`), which passes through states a crash can stop in: a
 * file under two names, or an empty file or folder holding the destination.
 *
 * The first half puts something under the name at the last moment and checks
 * it is kept. The second stops the move inside each of those states, as a
 * process that died would, runs the recovery, and requires the oracle to find
 * nothing wrong and the content to exist exactly once.
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
  envContext = await setupTestEnv({ tag: 'trash-no-overwrite-' });
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

const trash = (relative) =>
  operations.moveToTrash({
    absolutePath: volume(relative),
    logicalPath: relative,
    space: 'volume',
    deletedBy: 'user-1',
    deletedByLabel: 'alice',
  });

const zoneOf = () => store.listZones(db).find((zone) => zone.root === volume('Projects'));
const rowsOf = (zone) => store.listItemsByZone(db, zone.id);
const payloadOf = (item) => zones.itemPaths(volume('Projects'), item.id).payload;

const expectConsistent = async (zone) => {
  const result = await verify.verifyZone(zone);
  expect(result.violations).toEqual([]);
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

const CLIENT_TREE = {
  'brief.txt': 'the brief',
  'drafts/v1.txt': 'first draft',
  'drafts/v2.txt': 'second, longer draft',
};

const writeTree = async () => {
  for (const [relative, content] of Object.entries(CLIENT_TREE)) {
    await write(`Projects/client/${relative}`, content);
  }
};

const targetOf = (method, args) => (method === 'link' ? args[1] : args[0]);

/**
 * Run `arrive` just before `method` touches `target`: someone taking the name
 * at the last moment. `arrive` is synchronous, so it does not go through the
 * spied method itself.
 */
const arriveBefore = (method, target, arrive) => {
  const original = fsp[method].bind(fsp);
  vi.spyOn(fsp, method).mockImplementation(async (...args) => {
    if (targetOf(method, args) === target) arrive();
    return original(...args);
  });
};

/** Stop the process just before `method` touches `target`. */
const crashBefore = (method, target, point) => {
  const original = fsp[method].bind(fsp);
  vi.spyOn(fsp, method).mockImplementation(async (...args) => {
    if (targetOf(method, args) === target) failpoints.crash(point);
    return original(...args);
  });
};

/** Stop the process just after `method` created `target`. */
const crashAfterCreating = (method, target, point) => {
  const original = fsp[method].bind(fsp);
  vi.spyOn(fsp, method).mockImplementation(async (...args) => {
    const result = await original(...args);
    if (targetOf(method, args) === target) {
      if (method === 'open') await result.close();
      failpoints.crash(point);
    }
    return result;
  });
};

/** A filesystem without hard links. */
const withoutHardLinks = () =>
  vi
    .spyOn(fsp, 'link')
    .mockRejectedValue(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));

/** A process that died holds nothing: no spy, no failpoint, no operation in flight. */
const restart = () => {
  vi.restoreAllMocks();
  failpoints.clear();
  operations.inflight.clear();
};

describe('a restore whose name is taken at the last moment', () => {
  it('keeps a file that arrived there, and leaves the item in the trash', async () => {
    await write('Projects/report.txt', 'the content');
    const { item } = await trash('Projects/report.txt');
    arriveBefore('link', volume('Projects/report.txt'), () =>
      fsSync.writeFileSync(volume('Projects/report.txt'), 'someone else’s')
    );

    const result = await operations.restoreItem(item.id);

    expect(result.status).toBe('busy');
    expect(await fs.readFile(volume('Projects/report.txt'), 'utf8')).toBe('someone else’s');
    expect(await fs.readFile(payloadOf(item), 'utf8')).toBe('the content');
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  it('keeps a folder that arrived there, with what is in it, and never merges into it', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    arriveBefore('mkdir', volume('Projects/client'), () => {
      fsSync.mkdirSync(volume('Projects/client'));
      fsSync.writeFileSync(volume('Projects/client/theirs.txt'), 'theirs');
    });

    const result = await operations.restoreItem(item.id);

    expect(result.status).toBe('busy');
    expect(await readTree(volume('Projects/client'))).toEqual({ 'theirs.txt': 'theirs' });
    expect(await readTree(payloadOf(item))).toEqual(CLIENT_TREE);
    await expectConsistent(zoneOf());
  });

  it('keeps an empty folder that arrived there', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    arriveBefore('mkdir', volume('Projects/client'), () =>
      fsSync.mkdirSync(volume('Projects/client'))
    );

    const result = await operations.restoreItem(item.id);

    expect(result.status).toBe('busy');
    expect(await fs.readdir(volume('Projects/client'))).toEqual([]);
    expect(await readTree(payloadOf(item))).toEqual(CLIENT_TREE);
    await expectConsistent(zoneOf());
  });

  it('keeps a file that arrived where an entry of a deleted folder was going', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    const destination = volume('Projects/client/drafts/v2.txt');
    arriveBefore('link', destination, () => fsSync.writeFileSync(destination, 'theirs'));

    const result = await operations.restoreEntry(item.id, 'drafts/v2.txt');

    expect(result.status).toBe('busy');
    expect(await fs.readFile(destination, 'utf8')).toBe('theirs');
    expect(await readTree(payloadOf(item))).toEqual(CLIENT_TREE);
    await expectConsistent(zoneOf());
  });

  it('across disks, keeps what arrived and lands the copy under the next name', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    await fs.mkdir(volume('Archive'), { recursive: true });
    vi.spyOn(zones, 'sameDevice').mockResolvedValue(false);
    arriveBefore('mkdir', volume('Archive/client'), () => {
      fsSync.mkdirSync(volume('Archive/client'));
      fsSync.writeFileSync(volume('Archive/client/theirs.txt'), 'theirs');
    });

    const result = await operations.restoreItem(item.id, {
      destinationDirectory: volume('Archive'),
    });

    expect(result.status).toBe('restored');
    expect((await fs.readdir(volume('Archive'))).sort()).toEqual(['client', 'client (1)']);
    expect(await readTree(volume('Archive/client'))).toEqual({ 'theirs.txt': 'theirs' });
    expect(await readTree(volume('Archive/client (1)'))).toEqual(CLIENT_TREE);
    await expectConsistent(zoneOf());
  });

  it('leaves nothing in the trash when the old name of a moved file stayed behind', async () => {
    await write('Projects/report.txt', 'the content');
    const { item } = await trash('Projects/report.txt');
    const unlink = fsp.unlink.bind(fsp);
    let refused = false;
    vi.spyOn(fsp, 'unlink').mockImplementation(async (target) => {
      if (target === payloadOf(item) && !refused) {
        refused = true;
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      return unlink(target);
    });

    const result = await operations.restoreItem(item.id);

    expect(result.status).toBe('restored');
    expect(await fs.readFile(volume('Projects/report.txt'), 'utf8')).toBe('the content');
    expect(await exists(payloadOf(item))).toBe(false);
    await expectConsistent(zoneOf());
  });
});

describe('a crash inside the move out of the trash', () => {
  it('after a file was linked at its destination: the restore finishes', async () => {
    await write('Projects/report.txt', 'the content');
    const { item } = await trash('Projects/report.txt');
    crashBefore('unlink', payloadOf(item), 'after-link');

    await expect(operations.restoreItem(item.id)).rejects.toMatchObject({ simulatedCrash: true });
    restart();
    await operations.recoverZone(zoneOf());

    expect(await fs.readFile(volume('Projects/report.txt'), 'utf8')).toBe('the content');
    expect(await exists(payloadOf(item))).toBe(false);
    expect(rowsOf(zoneOf())).toEqual([]);
    await expectConsistent(zoneOf());
  });

  it('after the destination folder was created empty: it goes, and the item stays in the trash', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    crashAfterCreating('mkdir', volume('Projects/client'), 'after-placeholder');

    await expect(operations.restoreItem(item.id)).rejects.toMatchObject({ simulatedCrash: true });
    restart();
    await operations.recoverZone(zoneOf());

    expect(await exists(volume('Projects/client'))).toBe(false);
    expect(await readTree(payloadOf(item))).toEqual(CLIENT_TREE);
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  it('after an empty file held the name where there are no hard links: it goes', async () => {
    await write('Projects/report.txt', 'the content');
    const { item } = await trash('Projects/report.txt');
    withoutHardLinks();
    crashAfterCreating('open', volume('Projects/report.txt'), 'after-placeholder');

    await expect(operations.restoreItem(item.id)).rejects.toMatchObject({ simulatedCrash: true });
    restart();
    await operations.recoverZone(zoneOf());

    expect(await exists(volume('Projects/report.txt'))).toBe(false);
    expect(await fs.readFile(payloadOf(item), 'utf8')).toBe('the content');
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  it('never takes a file with content at the destination for the empty one', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    crashAfterCreating('mkdir', volume('Projects/client'), 'after-placeholder');

    await expect(operations.restoreItem(item.id)).rejects.toMatchObject({ simulatedCrash: true });
    restart();
    // Someone puts a file in that folder before the server comes back.
    await write('Projects/client/theirs.txt', 'theirs');
    await operations.recoverZone(zoneOf());

    expect(await readTree(volume('Projects/client'))).toEqual({ 'theirs.txt': 'theirs' });
    expect(await readTree(payloadOf(item))).toEqual(CLIENT_TREE);
    await expectConsistent(zoneOf());
  });

  it('after an entry of a deleted folder was linked at its destination: it is out, and the size true', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    const inside = path.join(payloadOf(item), 'drafts/v2.txt');
    crashBefore('unlink', inside, 'after-link');

    await expect(operations.restoreEntry(item.id, 'drafts/v2.txt')).rejects.toMatchObject({
      simulatedCrash: true,
    });
    restart();
    await operations.recoverZone(zoneOf());

    expect(await fs.readFile(volume('Projects/client/drafts/v2.txt'), 'utf8')).toBe(
      'second, longer draft'
    );
    expect(await exists(inside)).toBe(false);
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  it('after the destination of a folder entry was created empty: it goes, and the entry stays', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    crashAfterCreating('mkdir', volume('Projects/client/drafts'), 'after-placeholder');

    await expect(operations.restoreEntry(item.id, 'drafts')).rejects.toMatchObject({
      simulatedCrash: true,
    });
    restart();
    await operations.recoverZone(zoneOf());

    expect(await exists(volume('Projects/client/drafts'))).toBe(false);
    expect(await readTree(payloadOf(item))).toEqual(CLIENT_TREE);
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });

  it('across disks, after the destination folder was created empty: the copy lands under its own name', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    await fs.mkdir(volume('Archive'), { recursive: true });
    vi.spyOn(zones, 'sameDevice').mockResolvedValue(false);
    crashAfterCreating('mkdir', volume('Archive/client'), 'after-placeholder');

    await expect(
      operations.restoreItem(item.id, { destinationDirectory: volume('Archive') })
    ).rejects.toMatchObject({ simulatedCrash: true });
    restart();
    await operations.recoverZone(zoneOf());

    expect(await fs.readdir(volume('Archive'))).toEqual(['client']);
    expect(await readTree(volume('Archive/client'))).toEqual(CLIENT_TREE);
    expect(rowsOf(zoneOf())).toEqual([]);
    await expectConsistent(zoneOf());
  });

  it('across disks, after a copied file was linked at its destination: it lands once', async () => {
    await write('Projects/report.txt', 'the content');
    const { item } = await trash('Projects/report.txt');
    await fs.mkdir(volume('Archive'), { recursive: true });
    vi.spyOn(zones, 'sameDevice').mockResolvedValue(false);
    const staging = path.join(volume('Archive'), `.nextexplorer-restoring-${item.id}`);
    crashBefore('unlink', staging, 'after-link');

    await expect(
      operations.restoreItem(item.id, { destinationDirectory: volume('Archive') })
    ).rejects.toMatchObject({ simulatedCrash: true });
    restart();
    await operations.recoverZone(zoneOf());

    expect(await fs.readdir(volume('Archive'))).toEqual(['report.txt']);
    expect(await fs.readFile(volume('Archive/report.txt'), 'utf8')).toBe('the content');
    expect(rowsOf(zoneOf())).toEqual([]);
    await expectConsistent(zoneOf());
  });
});

describe('what the recovery leaves at a destination', () => {
  it('keeps what someone wrote into the empty file before the server came back', async () => {
    await write('Projects/report.txt', 'the content');
    const { item } = await trash('Projects/report.txt');
    withoutHardLinks();
    crashAfterCreating('open', volume('Projects/report.txt'), 'after-placeholder');

    await expect(operations.restoreItem(item.id)).rejects.toMatchObject({ simulatedCrash: true });
    restart();
    await fs.writeFile(volume('Projects/report.txt'), 'written into it meanwhile');
    await operations.recoverZone(zoneOf());

    expect(await fs.readFile(volume('Projects/report.txt'), 'utf8')).toBe(
      'written into it meanwhile'
    );
    expect(await fs.readFile(payloadOf(item), 'utf8')).toBe('the content');
    await expectConsistent(zoneOf());
  });

  it('keeps an empty folder that was there before the restore began', async () => {
    await writeTree();
    const { item } = await trash('Projects/client');
    await fs.mkdir(volume('Projects/client'));
    store.setItemState(db, item.id, 'restoring', { restorePath: volume('Projects/client') });
    // The restore is recorded as beginning an hour after the folder appeared.
    db.prepare('UPDATE trash_items SET updated_at = ? WHERE id = ?').run(
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      item.id
    );

    await operations.recoverZone(zoneOf());

    expect(await fs.readdir(volume('Projects/client'))).toEqual([]);
    expect(await readTree(payloadOf(item))).toEqual(CLIENT_TREE);
    expect(store.getItem(db, item.id).state).toBe('trashed');
    await expectConsistent(zoneOf());
  });
});
