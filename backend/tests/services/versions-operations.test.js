import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Keeping what a save replaces — and surviving a crash at any step of it.
 *
 * Every test ends on the zone's oracle, which now checks the versions beside
 * the trash. The crash tests stop a capture at each of its step boundaries,
 * run the recovery as a restarted process would, and require that the oracle
 * finds nothing wrong and that no content was lost: the file holds either its
 * old content with no version, or its new content with the old one kept.
 */

const fsp = require('fs/promises');

let envContext;
let operations;
let store;
let trashStore;
let zones;
let failpoints;
let verify;
let clock;
let settingsService;
let maintenance;
let db;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'versions-operations-' });
  operations = load('src/services/versions/operations');
  store = load('src/services/versions/store');
  trashStore = load('src/services/trash/store');
  zones = load('src/services/trash/zones');
  failpoints = load('src/services/trash/failpoints');
  verify = load('src/services/trash/verify');
  clock = load('src/services/trash/clock');
  settingsService = load('src/services/settingsService');
  maintenance = load('src/services/trash/maintenance');
  db = await load('src/services/db').getDb();
});

afterEach(async () => {
  failpoints.clear();
  maintenance.stop();
  vi.restoreAllMocks();
  await envContext.cleanup();
});

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const write = async (relative, content) => {
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
};

const read = (relative) => fs.readFile(volume(relative), 'utf8');

const save = async (relative, content, meta = {}) => {
  const target = volume(relative);
  const temporary = operations.temporaryPathFor(target);
  await fs.writeFile(temporary, content);
  return operations.replaceWithTemporary(target, temporary, meta);
};

const zoneOf = () => trashStore.listZones(db).find((zone) => zone.root === volume('Projects'));

const historyOf = (relative) => {
  const zone = zoneOf();
  return zone
    ? store.findFileAt(db, zone.id, relative.replace(/^Projects\//, ''), [
        'live',
        'orphaned',
        'trashed',
        'purging',
      ])
    : null;
};

const versionsOf = (relative) => {
  const file = historyOf(relative);
  return file ? store.listVersionsOfFile(db, file.id) : [];
};

const contentOf = (version) =>
  fs.readFile(path.join(zones.versionsDirectory(zoneOf().root), version.id), 'utf8');

const expectConsistent = async () => {
  const zone = zoneOf();
  if (!zone) return;
  const result = await verify.verifyZone(zone);
  expect(result.violations).toEqual([]);
};

const setVersions = (values) =>
  settingsService.setSystemSetting('system', 'versions', {
    ...settingsService.sanitizeVersions({}),
    ...values,
  });

const leftovers = async (relative) =>
  (await fs.readdir(path.dirname(volume(relative)))).filter((name) => name.endsWith('.tmp'));

describe('saving over a file', () => {
  it('keeps the old content as a version without copying it', async () => {
    await write('Projects/report.txt', 'first draft');
    const inode = (await fs.stat(volume('Projects/report.txt'))).ino;

    const result = await save('Projects/report.txt', 'second draft', {
      author: { id: 'user-1', label: 'alice' },
      source: 'editor',
    });

    expect(result.status).toBe('replaced');
    expect(await read('Projects/report.txt')).toBe('second draft');
    const [version] = versionsOf('Projects/report.txt');
    expect(version).toMatchObject({ state: 'kept', size: 11, source: 'external' });
    expect(await contentOf(version)).toBe('first draft');
    const content = await fs.stat(path.join(zones.versionsDirectory(zoneOf().root), version.id));
    expect(content.ino).toBe(inode);
    expect(await leftovers('Projects/report.txt')).toEqual([]);
    await expectConsistent();
  });

  it('credits each version to whoever wrote that content', async () => {
    await write('Projects/report.txt', 'from outside');
    await save('Projects/report.txt', 'alice wrote this', {
      author: { id: 'user-1', label: 'alice' },
      source: 'editor',
    });
    await save('Projects/report.txt', 'bob wrote this', {
      author: { id: 'user-2', label: 'bob' },
      source: 'onlyoffice',
    });

    const [newest, oldest] = versionsOf('Projects/report.txt');
    expect(await contentOf(newest)).toBe('alice wrote this');
    expect(newest).toMatchObject({ authorId: 'user-1', authorLabel: 'alice', source: 'editor' });
    expect(await contentOf(oldest)).toBe('from outside');
    expect(oldest).toMatchObject({ authorId: null, source: 'external' });
  });

  it('keeps the permissions of the file it replaces', async () => {
    await write('Projects/script.sh', 'echo one');
    await fs.chmod(volume('Projects/script.sh'), 0o750);

    await save('Projects/script.sh', 'echo two');

    expect((await fs.stat(volume('Projects/script.sh'))).mode & 0o777).toBe(0o750);
  });

  it('creates a new file without starting a history', async () => {
    await fs.mkdir(volume('Projects'), { recursive: true });

    const result = await save('Projects/new.txt', 'hello');

    expect(result.status).toBe('created');
    expect(await read('Projects/new.txt')).toBe('hello');
    expect(historyOf('Projects/new.txt')).toBeNull();
  });

  it('changes nothing, and keeps nothing, when the content is the same', async () => {
    await write('Projects/report.txt', 'same');
    const before = await fs.stat(volume('Projects/report.txt'));

    const result = await save('Projects/report.txt', 'same');

    expect(result.status).toBe('unchanged');
    expect((await fs.stat(volume('Projects/report.txt'))).ino).toBe(before.ino);
    expect(versionsOf('Projects/report.txt')).toEqual([]);
    expect(await leftovers('Projects/report.txt')).toEqual([]);
  });

  it('never keeps the same content twice in a row', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    // Put back from outside to the content already kept, then saved again.
    await fs.writeFile(volume('Projects/report.txt'), 'A');

    await save('Projects/report.txt', 'C');

    expect(await Promise.all(versionsOf('Projects/report.txt').map(contentOf))).toEqual(['A']);
    expect(await read('Projects/report.txt')).toBe('C');
  });

  it('keeps nothing while versions are switched off', async () => {
    await setVersions({ enabled: false });
    await write('Projects/report.txt', 'one');

    const result = await save('Projects/report.txt', 'two');

    expect(result).toEqual({ status: 'replaced', version: null });
    expect(await read('Projects/report.txt')).toBe('two');
    expect(historyOf('Projects/report.txt')).toBeNull();
  });

  it('keeps no version larger than the whole zone could hold, and says so', async () => {
    vi.spyOn(maintenance, 'measureVolume').mockResolvedValue({ totalBytes: 100, freeBytes: 1e9 });
    await write('Projects/big.bin', 'x'.repeat(50));

    await save('Projects/big.bin', 'y'.repeat(50));

    expect(await read('Projects/big.bin')).toBe('y'.repeat(50));
    expect(versionsOf('Projects/big.bin')).toEqual([]);
    const events = trashStore.listEvents(db, { zoneId: zoneOf().id });
    expect(events.map((event) => event.kind)).toContain('version-too-large');
  });

  it('renames the old content aside where the filesystem has no hard links', async () => {
    vi.spyOn(fsp, 'link').mockRejectedValue(
      Object.assign(new Error('no links'), { code: 'EPERM' })
    );
    await write('Projects/report.txt', 'old');

    await save('Projects/report.txt', 'new');

    expect(await read('Projects/report.txt')).toBe('new');
    expect(await Promise.all(versionsOf('Projects/report.txt').map(contentOf))).toEqual(['old']);
    await expectConsistent();
  });

  it('puts the old content back when the new one cannot take its place', async () => {
    await write('Projects/report.txt', 'old');
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('.tmp')) throw Object.assign(new Error('refused'), { code: 'EIO' });
      return rename(from, to);
    });

    await expect(save('Projects/report.txt', 'new')).rejects.toThrow('refused');

    expect(await read('Projects/report.txt')).toBe('old');
    expect(versionsOf('Projects/report.txt')).toEqual([]);
    await expectConsistent();
  });

  it('takes two saves to the same file one after the other', async () => {
    await write('Projects/report.txt', 'A');

    await Promise.all([save('Projects/report.txt', 'B'), save('Projects/report.txt', 'C')]);

    const kept = await Promise.all(versionsOf('Projects/report.txt').map(contentOf));
    const current = await read('Projects/report.txt');
    // Whichever came second kept whichever came first: never a state that did not exist.
    expect(kept.sort()).toEqual(current === 'C' ? ['A', 'B'] : ['A', 'C']);
    await expectConsistent();
  });

  it('thins the history as soon as a save goes over the limit', async () => {
    await setVersions({ maxPerFile: 2 });
    await write('Projects/report.txt', 'v0');
    for (const content of ['v1', 'v2', 'v3', 'v4']) {
      // eslint-disable-next-line no-await-in-loop
      await save('Projects/report.txt', content);
    }

    expect(await Promise.all(versionsOf('Projects/report.txt').map(contentOf))).toEqual([
      'v3',
      'v2',
    ]);
    await expectConsistent();
  });
});

describe('one version per editing session', () => {
  const session = (key = 'document-key', startedAt = Date.now() - 1000) => ({ key, startedAt });

  it('keeps the document as it was before the session, and not every save after', async () => {
    await write('Projects/offer.docx', 'before');

    await save('Projects/offer.docx', 'autosave 1', { session: session(), source: 'onlyoffice' });
    await save('Projects/offer.docx', 'autosave 2', { session: session(), source: 'onlyoffice' });
    await save('Projects/offer.docx', 'autosave 3', { session: session(), source: 'onlyoffice' });

    expect(await Promise.all(versionsOf('Projects/offer.docx').map(contentOf))).toEqual(['before']);
    expect(await read('Projects/offer.docx')).toBe('autosave 3');
  });

  it('leaves a checkpoint once the session has run long enough', async () => {
    await setVersions({ sessionCheckpointMinutes: 10 });
    await write('Projects/offer.docx', 'before');
    const start = Date.now();
    vi.spyOn(clock, 'now').mockReturnValue(start);
    await save('Projects/offer.docx', 'minute 1', { session: session() });
    clock.now.mockReturnValue(start + 4 * 60 * 1000);
    await save('Projects/offer.docx', 'minute 4', { session: session() });
    clock.now.mockReturnValue(start + 11 * 60 * 1000);
    await save('Projects/offer.docx', 'minute 11', { session: session() });

    expect(await Promise.all(versionsOf('Projects/offer.docx').map(contentOf))).toEqual([
      'minute 4',
      'before',
    ]);
  });

  it('keeps what was saved on purpose when the session saves over it', async () => {
    await write('Projects/offer.docx', 'before');
    await save('Projects/offer.docx', 'draft', { session: session() });
    await save('Projects/offer.docx', 'saved on purpose', { session: session(), explicit: true });
    await save('Projects/offer.docx', 'typing again', { session: session() });

    expect(await Promise.all(versionsOf('Projects/offer.docx').map(contentOf))).toEqual([
      'saved on purpose',
      'before',
    ]);
  });

  it('starts over for the next session', async () => {
    await write('Projects/offer.docx', 'before');
    await save('Projects/offer.docx', 'monday', { session: session('monday-key') });
    await save('Projects/offer.docx', 'tuesday', { session: session('tuesday-key') });

    expect(await Promise.all(versionsOf('Projects/offer.docx').map(contentOf))).toEqual([
      'monday',
      'before',
    ]);
  });

  it('keeps content that changed outside the application during the session', async () => {
    await write('Projects/offer.docx', 'before');
    await save('Projects/offer.docx', 'draft', { session: session() });
    await fs.writeFile(volume('Projects/offer.docx'), 'changed over SMB');

    await save('Projects/offer.docx', 'draft again', { session: session() });

    expect(await Promise.all(versionsOf('Projects/offer.docx').map(contentOf))).toEqual([
      'changed over SMB',
      'before',
    ]);
  });

  it('sets aside a save from a session opened before the file was restored', async () => {
    await write('Projects/offer.docx', 'before');
    await save('Projects/offer.docx', 'restored content', { author: { id: 'u', label: 'u' } });
    const file = historyOf('Projects/offer.docx');
    store.setRestoredAt(db, file.id, new Date(Date.now()).toISOString());

    const result = await save('Projects/offer.docx', 'stale editor content', {
      session: session('old-key', Date.now() - 60 * 1000),
      author: { id: 'user-2', label: 'bob' },
      source: 'onlyoffice',
    });

    expect(result.status).toBe('set-aside');
    expect(await read('Projects/offer.docx')).toBe('restored content');
    const [aside] = versionsOf('Projects/offer.docx');
    expect(aside).toMatchObject({ aside: true, authorLabel: 'bob', source: 'onlyoffice' });
    expect(await contentOf(aside)).toBe('stale editor content');
    await expectConsistent();
  });
});

describe('letting versions go', () => {
  it('removes one version and its content', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    await save('Projects/report.txt', 'C');
    const [newest, oldest] = versionsOf('Projects/report.txt');

    expect((await operations.purgeVersion(oldest.id)).status).toBe('purged');

    expect(versionsOf('Projects/report.txt').map((version) => version.id)).toEqual([newest.id]);
    await expectConsistent();
  });

  it('removes a whole history with every version', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    await save('Projects/report.txt', 'C');
    const file = historyOf('Projects/report.txt');

    expect(await operations.purgeFile(file.id)).toEqual({ status: 'purged', left: 0 });

    expect(store.getFile(db, file.id)).toBeNull();
    expect(await fs.readdir(zones.versionsDirectory(zoneOf().root))).toEqual([]);
    await expectConsistent();
  });

  it('hides a version whose disk is not there, and finishes once it is back', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    const [version] = versionsOf('Projects/report.txt');
    const marker = zones.markerPath(zoneOf().root);
    const saved = await fs.readFile(marker);
    await fs.rm(marker);

    expect((await operations.purgeVersion(version.id)).status).toBe('unavailable');
    expect(versionsOf('Projects/report.txt')).toEqual([]);

    await fs.writeFile(marker, saved);
    await operations.recoverZone(zoneOf());
    expect(store.getVersion(db, version.id)).toBeNull();
    await expectConsistent();
  });
});

describe('a capture interrupted by a crash', () => {
  const crashAt = (name) => failpoints.set(name, () => failpoints.crash(name));

  const cases = [
    { point: 'version:after-row', linked: true, expected: 'old' },
    { point: 'version:after-link', linked: true, expected: 'old' },
    { point: 'version:after-rename', linked: true, expected: 'new' },
    { point: 'version:after-link', linked: false, expected: 'old' },
    { point: 'version:between-renames', linked: false, expected: 'old' },
    { point: 'version:after-rename', linked: false, expected: 'new' },
  ];

  it.each(cases)(
    'recovers at $point (hard links: $linked), and loses nothing',
    async ({ point, linked, expected }) => {
      if (!linked) {
        vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error('no'), { code: 'EPERM' }));
      }
      await write('Projects/report.txt', 'old');
      crashAt(point);

      await expect(save('Projects/report.txt', 'new')).rejects.toThrow('Simulated crash');
      failpoints.clear();
      vi.restoreAllMocks();

      await operations.recoverZone(zoneOf(), { graceMs: 0 });

      expect(await read('Projects/report.txt')).toBe(expected);
      const kept = await Promise.all(versionsOf('Projects/report.txt').map(contentOf));
      expect(kept).toEqual(expected === 'new' ? ['old'] : []);
      await expectConsistent();
    }
  );

  it('finishes a purge a crash interrupted', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    const [version] = versionsOf('Projects/report.txt');
    crashAt('version-purge:after-intent');

    await expect(operations.purgeVersion(version.id)).rejects.toThrow('Simulated crash');
    failpoints.clear();
    await operations.recoverZone(zoneOf());

    expect(store.getVersion(db, version.id)).toBeNull();
    await expectConsistent();
  });
});

describe('the recovery of a zone', () => {
  it('removes content with no version once it is old enough, and not before', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    const stray = path.join(zones.versionsDirectory(zoneOf().root), '0123456789abcdef-stray');
    await fs.writeFile(stray, 'left behind');

    await operations.recoverZone(zoneOf());
    expect(await fs.readFile(stray, 'utf8')).toBe('left behind');

    const report = await operations.recoverZone(zoneOf(), { graceMs: 0 });
    expect(report.removedContents).toBe(1);
    await expect(fs.stat(stray)).rejects.toThrow();
    await expectConsistent();
  });

  it('drops a version whose content vanished, and records it', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    const [version] = versionsOf('Projects/report.txt');
    await fs.rm(path.join(zones.versionsDirectory(zoneOf().root), version.id));

    const report = await operations.recoverZone(zoneOf());

    expect(report.lost).toBe(1);
    expect(store.getVersion(db, version.id)).toBeNull();
    await expectConsistent();
  });

  it('touches nothing when too many contents have vanished at once', async () => {
    await write('Projects/report.txt', 'v0');
    for (let index = 1; index <= 6; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await save('Projects/report.txt', `v${index}`);
    }
    await fs.rm(zones.versionsDirectory(zoneOf().root), { recursive: true });

    const report = await operations.recoverZone(zoneOf());

    expect(report.breaker).toBe(true);
    expect(versionsOf('Projects/report.txt')).toHaveLength(6);
  });

  it('leaves a zone whose marker is gone alone', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    await fs.rm(zones.markerPath(zoneOf().root));

    expect(await operations.recoverZone(zoneOf())).toMatchObject({
      skipped: true,
      reason: 'missing',
    });
  });
});

describe('the oracle', () => {
  it('reports a version without content, content without a version, and a wrong size', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    await save('Projects/report.txt', 'C');
    const [newest, oldest] = versionsOf('Projects/report.txt');
    const directory = zones.versionsDirectory(zoneOf().root);
    await fs.rm(path.join(directory, newest.id));
    await fs.writeFile(path.join(directory, oldest.id), 'much longer than before');
    await fs.writeFile(path.join(directory, '0123456789abcdef-stray'), 'x');

    const { violations } = await verify.verifyZone(zoneOf());

    expect(violations.map((violation) => violation.invariant).sort()).toEqual(['I2', 'I2', 'I8']);
  });

  it('reports a version left in a passing state, and a history in the trash without its item', async () => {
    await write('Projects/report.txt', 'A');
    await save('Projects/report.txt', 'B');
    const [version] = versionsOf('Projects/report.txt');
    store.setVersionState(db, version.id, 'capturing');
    db.prepare("UPDATE version_files SET state = 'trashed', trash_item_id = 'gone'").run();

    const { violations } = await verify.verifyZone(zoneOf());

    expect(violations.map((violation) => violation.invariant).sort()).toEqual(['I3', 'I4']);
  });
});
