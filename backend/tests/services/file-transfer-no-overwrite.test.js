import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A copy or a move never replaces, pours into, or removes what is under its name.
 *
 * A transfer used to take its name first, with an empty file or folder, and
 * write into it for as long as the copy lasted. That name was visible the whole
 * time: someone saving a file into the folder being filled could have it
 * replaced by the copied file of the same name, a cancelled copy removed the
 * folder with whatever someone had put into it, a move renamed over the empty
 * placeholder someone had just written into, and a stop half-way left the
 * reservation or a half-filled folder in view for good.
 *
 * A copy is now written under a hidden `.nextexplorer-copying-` name beside
 * where it goes, recorded as in flight, and put under its name only once whole,
 * by an operation that fails when the name is held. A move on one disk is put
 * there directly the same way. Each test puts something at the worst moment:
 * while the copy runs, just before it is placed, while it is cancelled or
 * failing. Both engines run every case; where rsync cannot run (macOS ships
 * one too old for it), the native engine falls back to streams for the copy
 * and still removes with `rm`.
 */

let currentEnv;

const ENGINES = ['native', 'stream'];
const ADMIN = { id: 'admin', roles: ['admin'] };
const MiB = 1024 * 1024;
/** The hidden entry a copy is written under, and nothing derived from a file name. */
const STAGING =
  /^\.nextexplorer-copying-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(async () => {
  vi.restoreAllMocks();
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const at = (...segments) => path.join(currentEnv.volumeDir, ...segments);

const setup = async (engine, { folderSize = 'off' } = {}) => {
  currentEnv = await setupTestEnv({
    tag: `transfer-no-overwrite-${engine}-`,
    env: { FILE_TRANSFER_ENGINE: engine, FOLDER_SIZE_MODE: folderSize },
  });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
  ).run(now, now);
  fs.mkdirSync(at('From'), { recursive: true });
  fs.mkdirSync(at('To'), { recursive: true });
};

/** Loaded when used, after any spy: the service keeps its own reference to spawn. */
const loadService = () => currentEnv.requireFresh('src/services/fileTransferService');

const transfer = async (items, destination, operation, { onProgress, signal } = {}) => {
  const service = loadService();
  const prep = await service.prepareTransfer(items, destination, operation, { user: ADMIN });
  return service.executeTransfer(prep, operation, onProgress, { signal });
};

const names = (directory) => fs.readdirSync(directory).sort();
const read = (file) => fs.readFileSync(file, 'utf8');
const staged = (directory) => names(directory).filter((name) => STAGING.test(name));
const hidden = (directory) => names(directory).filter((name) => name.startsWith('.'));

const journalDirectory = () => path.join(currentEnv.cacheDir, 'in-flight');
/** The in-flight records, as written. */
const journal = () =>
  (fs.existsSync(journalDirectory()) ? fs.readdirSync(journalDirectory()) : [])
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      content: fs.readFileSync(path.join(journalDirectory(), name), 'utf8'),
    }));
const recordedPaths = () => journal().map((record) => JSON.parse(record.content).path);

/**
 * Whether the hidden entry exists by the first progress report. The service
 * makes a folder, and streams make a file, before any byte moves; rsync makes a
 * single file itself, and may report 0% before it has.
 */
const madeBeforeTheCopyTool = (kind, engine) => kind === 'folder' || engine === 'stream';

/** Whether a progress report says bytes are moving, from either engine. */
const moving = ({ copiedBytes, percent }) => copiedBytes > 0 || percent != null;

/**
 * Run `arrive` the moment the transfer first creates, writes, links, renames
 * onto or hands rsync the path `target`, just before it does. With `whenStaged`,
 * only once a whole hidden copy is waiting beside it: the last moment before
 * the copy is put in place.
 *
 * `crossDeviceFrom` makes a link or a rename of that source report EXDEV, as a
 * move to another disk does; it lives here because both need the one spy.
 */
const arriveJustBefore = (target, arrive, { crossDeviceFrom, whenStaged = false } = {}) => {
  let arrived = false;
  const touch = (candidate) => {
    if (arrived || typeof candidate !== 'string') return;
    if (candidate.replace(/[/\\]+$/, '') !== target) return;
    if (whenStaged && staged(path.dirname(target)).length === 0) return;
    arrived = true;
    arrive();
  };

  for (const [method, pathIndex] of [
    ['open', 0],
    ['mkdir', 0],
    ['writeFile', 0],
    ['copyFile', 1],
    ['symlink', 1],
    ['link', 1],
    ['rename', 1],
  ]) {
    const original = fsp[method].bind(fsp);
    vi.spyOn(fsp, method).mockImplementation(async (...args) => {
      touch(args[pathIndex]);
      if (
        (method === 'rename' || method === 'link') &&
        crossDeviceFrom &&
        args[0] === crossDeviceFrom
      ) {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      }
      return original(...args);
    });
  }

  const createWriteStream = fs.createWriteStream.bind(fs);
  vi.spyOn(fs, 'createWriteStream').mockImplementation((candidate, options) => {
    touch(candidate);
    return createWriteStream(candidate, options);
  });

  const spawn = childProcess.spawn.bind(childProcess);
  vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
    if (command === 'rsync') touch(args[args.length - 1]);
    return spawn(command, args, options);
  });

  return { arrived: () => arrived };
};

/** A move to another disk: the entry's own link or rename reports EXDEV. */
const acrossDisks = (source) => {
  const rename = fsp.rename.bind(fsp);
  const link = fsp.link.bind(fsp);
  const refuse = () =>
    Promise.reject(Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }));
  vi.spyOn(fsp, 'rename').mockImplementation((from, to) =>
    from === source ? refuse() : rename(from, to)
  );
  vi.spyOn(fsp, 'link').mockImplementation((from, to) =>
    from === source ? refuse() : link(from, to)
  );
};

const aFileArrives = (target) => () => fs.writeFileSync(target, 'theirs', { flag: 'wx' });
const aFolderArrives = (target) => () => {
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'theirs.txt'), 'theirs');
};

const seedAlbum = () => {
  fs.mkdirSync(at('From', 'Album', 'nested'), { recursive: true });
  fs.writeFileSync(at('From', 'Album', 'mine.txt'), 'mine');
  fs.writeFileSync(at('From', 'Album', 'nested', 'deep.txt'), 'deep');
};

/** Something large enough to be caught while it is written: a file, or a folder of three. */
const seedBig = (kind) => {
  if (kind === 'file') {
    fs.writeFileSync(at('From', 'big.bin'), Buffer.alloc(16 * MiB, 3));
    return { item: { path: 'From', name: 'big.bin' }, name: 'big.bin' };
  }
  fs.mkdirSync(at('From', 'big'));
  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(at('From', 'big', `part-${index}.bin`), Buffer.alloc(4 * MiB, index));
  }
  return { item: { path: 'From', name: 'big' }, name: 'big' };
};

const sourceIsWhole = (kind) => {
  if (kind === 'file') {
    expect(fs.statSync(at('From', 'big.bin')).size).toBe(16 * MiB);
  } else {
    expect(names(at('From', 'big'))).toEqual(['part-0.bin', 'part-1.bin', 'part-2.bin']);
  }
};

describe.each(ENGINES)('with the %s engine', (engine) => {
  describe('while a copy runs', () => {
    it.each(['file', 'folder'])(
      'nothing of a %s is under its name, only a hidden entry the journal records',
      async (kind) => {
        await setup(engine);
        const { item, name } = seedBig(kind);
        let seen = null;

        const result = await transfer([item], 'To', 'copy', {
          onProgress: (progress) => {
            if (seen || !moving(progress)) return;
            seen = { names: names(at('To')), recorded: recordedPaths() };
          },
        });

        expect(seen).not.toBeNull();
        // No entry under the name, no empty placeholder: only hidden ones.
        expect(seen.names).not.toContain(name);
        expect(seen.names.every((entry) => entry.startsWith('.'))).toBe(true);
        // The one it records is hidden, beside where it goes, named by nothing
        // of the file's, and what is there while it runs.
        expect(seen.recorded).toHaveLength(1);
        expect(path.dirname(seen.recorded[0])).toBe(at('To'));
        expect(path.basename(seen.recorded[0])).toMatch(STAGING);
        if (madeBeforeTheCopyTool(kind, engine)) {
          const stagingName = path.basename(seen.recorded[0]);
          expect(seen.names.some((entry) => entry.includes(stagingName))).toBe(true);
        }
        // Once placed: under its name, nothing hidden left, the record released.
        expect(result.items[0].to).toBe(`To/${name}`);
        expect(names(at('To'))).toEqual([name]);
        expect(journal()).toEqual([]);
      }
    );

    it('a folder someone makes under its name keeps what they put in it', async () => {
      await setup(engine);
      seedBig('folder');
      let made = false;

      const result = await transfer([{ path: 'From', name: 'big' }], 'To', 'copy', {
        onProgress: (progress) => {
          if (made || !moving(progress)) return;
          made = true;
          // A file of the same name as one being copied.
          fs.mkdirSync(at('To', 'big'));
          fs.writeFileSync(at('To', 'big', 'part-0.bin'), 'theirs');
        },
      });

      expect(made).toBe(true);
      expect(names(at('To', 'big'))).toEqual(['part-0.bin']);
      expect(read(at('To', 'big', 'part-0.bin'))).toBe('theirs');
      expect(result.items[0].to).toBe('To/big (1)');
      expect(names(at('To', 'big (1)'))).toEqual(['part-0.bin', 'part-1.bin', 'part-2.bin']);
      expect(fs.statSync(at('To', 'big (1)', 'part-2.bin')).size).toBe(4 * MiB);
      expect(names(at('To'))).toEqual(['big', 'big (1)']);
    });

    if (engine === 'native') {
      it.each([
        // A single file is written in place at the hidden path, which the journal
        // records; rsync's own temporary beside it would be recorded nowhere. A
        // folder's temporaries are inside the hidden folder already.
        ['a file', 'note.txt', (source, staging) => [source, staging], true],
        ['a folder', 'Album', (source, staging) => [`${source}/`, `${staging}/`], false],
      ])(
        'hands rsync the hidden entry for %s, never its name',
        async (_label, name, expected, expectedInPlace) => {
          await setup(engine);
          seedAlbum();
          fs.writeFileSync(at('From', 'note.txt'), 'mine');
          const calls = [];
          const spawn = childProcess.spawn.bind(childProcess);
          vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
            if (command === 'rsync') {
              calls.push({
                args: args.slice(-2),
                inPlace: args.includes('--inplace'),
                recorded: recordedPaths(),
              });
            }
            return spawn(command, args, options);
          });

          const result = await transfer([{ path: 'From', name }], 'To', 'copy');

          expect(calls.length).toBeGreaterThan(0);
          const [{ args, inPlace, recorded }] = calls;
          expect(inPlace).toBe(expectedInPlace);
          expect(recorded).toHaveLength(1);
          expect(path.basename(recorded[0])).toMatch(STAGING);
          expect(args).toEqual(expected(at('From', name), recorded[0]));
          expect(result.items[0].to).toBe(`To/${name}`);
          expect(names(at('To'))).toEqual([name]);
        }
      );
    }
  });

  describe('a copy cancelled half-way', () => {
    it.each([
      ['file', 'copy'],
      ['folder', 'copy'],
      ['file', 'move across disks'],
      ['folder', 'move across disks'],
    ])(
      'of a %s (%s) leaves nothing of its own, and keeps what someone put there meanwhile',
      async (kind, label) => {
        await setup(engine);
        const { item, name } = seedBig(kind);
        const crossDevice = label !== 'copy';
        if (crossDevice) acrossDisks(at('From', name));
        const controller = new AbortController();
        let during = null;

        await expect(
          transfer([item], 'To', crossDevice ? 'move' : 'copy', {
            signal: controller.signal,
            onProgress: (progress) => {
              if (during || !moving(progress)) return;
              during = hidden(at('To'));
              // Under another name, and under the very name the copy wants.
              fs.writeFileSync(at('To', 'other.txt'), 'someone');
              if (kind === 'file') {
                fs.writeFileSync(at('To', name), 'theirs');
              } else {
                fs.mkdirSync(at('To', name));
                fs.writeFileSync(at('To', name, 'part-1.bin'), 'theirs');
              }
              controller.abort();
            },
          })
        ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

        if (madeBeforeTheCopyTool(kind, engine)) expect(during.length).toBeGreaterThan(0);
        expect(names(at('To'))).toEqual([name, 'other.txt'].sort());
        expect(read(at('To', 'other.txt'))).toBe('someone');
        if (kind === 'file') {
          expect(read(at('To', name))).toBe('theirs');
        } else {
          expect(names(at('To', name))).toEqual(['part-1.bin']);
          expect(read(at('To', name, 'part-1.bin'))).toBe('theirs');
        }
        expect(journal()).toEqual([]);
        sourceIsWhole(kind);
      }
    );

    it('leaves nothing behind when a move is cancelled before anything is written', async () => {
      await setup(engine);
      seedAlbum();
      const controller = new AbortController();

      await expect(
        transfer([{ path: 'From', name: 'Album' }], 'To', 'move', {
          signal: controller.signal,
          // The first report names the entry, before it is moved.
          onProgress: () => controller.abort(),
        })
      ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

      expect(names(at('To'))).toEqual([]);
      expect(names(at('From', 'Album'))).toEqual(['mine.txt', 'nested']);
    });
  });

  describe('a copy stopped half-way by a stop of the server', () => {
    /**
     * What a stop leaves is the record and the hidden entry as far as it got.
     * Both are taken as they are at the instant bytes are moving, put back once
     * the transfer is over, and the next start — a fresh journal, of another
     * run — is asked to clear them.
     */
    it.each(['file', 'folder'])(
      'leaves a %s the next start removes, and nothing visible it touches',
      async (kind) => {
        await setup(engine);
        const { item, name } = seedBig(kind);
        const controller = new AbortController();
        const snapshot = path.join(currentEnv.tmpRoot, 'at-the-stop');
        let stop = null;

        await expect(
          transfer([item], 'To', 'copy', {
            signal: controller.signal,
            onProgress: (progress) => {
              if (stop || !moving(progress)) return;
              const records = journal();
              const target = records.length ? JSON.parse(records[0].content).path : null;
              const existed = Boolean(target) && fs.existsSync(target);
              if (existed) fs.cpSync(target, snapshot, { recursive: true, verbatimSymlinks: true });
              stop = { records, target, existed, visible: names(at('To')) };
              controller.abort();
            },
          })
        ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

        // At the stop, nothing was visible, and the hidden entry was recorded.
        expect(stop.visible.filter((entry) => !entry.startsWith('.'))).toEqual([]);
        expect(stop.records).toHaveLength(1);
        expect(path.dirname(stop.target)).toBe(at('To'));
        expect(path.basename(stop.target)).toMatch(STAGING);
        if (madeBeforeTheCopyTool(kind, engine)) expect(stop.existed).toBe(true);

        // The disk as the stop left it, and what people keep in the folder.
        fs.mkdirSync(journalDirectory(), { recursive: true });
        for (const record of stop.records) {
          fs.writeFileSync(path.join(journalDirectory(), record.name), record.content);
        }
        if (stop.existed) {
          fs.cpSync(snapshot, stop.target, { recursive: true, verbatimSymlinks: true });
        }
        fs.writeFileSync(at('To', 'other.txt'), 'someone');
        fs.writeFileSync(at('To', name), 'theirs');

        const { removed } = currentEnv
          .requireFresh('src/services/inFlightFiles')
          .sweepInterrupted();

        expect(removed).toBe(stop.existed ? 1 : 0);
        expect(names(at('To'))).toEqual([name, 'other.txt'].sort());
        expect(read(at('To', name))).toBe('theirs');
        expect(read(at('To', 'other.txt'))).toBe('someone');
        expect(journal()).toEqual([]);
      }
    );
  });

  describe('something arriving under the name, the last moment before a copy is placed', () => {
    it('keeps a file, and the copy lands under the next name', async () => {
      await setup(engine);
      fs.writeFileSync(at('From', 'note.txt'), 'mine');
      const intruder = arriveJustBefore(
        at('To', 'note.txt'),
        () => {
          // The copy is whole under its hidden name by now.
          const [entry] = staged(at('To'));
          expect(read(at('To', entry))).toBe('mine');
          aFileArrives(at('To', 'note.txt'))();
        },
        { whenStaged: true }
      );

      const result = await transfer([{ path: 'From', name: 'note.txt' }], 'To', 'copy');

      expect(intruder.arrived()).toBe(true);
      expect(read(at('To', 'note.txt'))).toBe('theirs');
      expect(result.items[0].to).toBe('To/note (1).txt');
      expect(read(at('To', 'note (1).txt'))).toBe('mine');
      expect(names(at('To'))).toEqual(['note (1).txt', 'note.txt']);
    });

    it('never merges into a folder, and the copy lands under the next name', async () => {
      await setup(engine);
      seedAlbum();
      const intruder = arriveJustBefore(
        at('To', 'Album'),
        () => {
          const [entry] = staged(at('To'));
          expect(names(at('To', entry))).toEqual(['mine.txt', 'nested']);
          aFolderArrives(at('To', 'Album'))();
        },
        { whenStaged: true }
      );

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'copy');

      expect(intruder.arrived()).toBe(true);
      expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
      expect(result.items[0].to).toBe('To/Album (1)');
      expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
      expect(read(at('To', 'Album (1)', 'nested', 'deep.txt'))).toBe('deep');
      expect(names(at('To'))).toEqual(['Album', 'Album (1)']);
    });
  });

  describe('something arriving under the name a move takes, on one disk', () => {
    it('keeps a file arriving just before the link, and the moved file lands under the next name', async () => {
      await setup(engine);
      fs.writeFileSync(at('From', 'note.txt'), 'mine');
      // `wx`: had an empty placeholder held the name, this would fail.
      const intruder = arriveJustBefore(at('To', 'note.txt'), aFileArrives(at('To', 'note.txt')));

      const result = await transfer([{ path: 'From', name: 'note.txt' }], 'To', 'move');

      expect(intruder.arrived()).toBe(true);
      expect(read(at('To', 'note.txt'))).toBe('theirs');
      expect(result.items[0]).toEqual({ from: 'From/note.txt', to: 'To/note (1).txt' });
      expect(read(at('To', 'note (1).txt'))).toBe('mine');
      expect(fs.existsSync(at('From', 'note.txt'))).toBe(false);
      expect(names(at('To'))).toEqual(['note (1).txt', 'note.txt']);
    });

    it('keeps a folder arriving just before its folder is made, and the moved folder lands under the next name', async () => {
      await setup(engine);
      seedAlbum();
      const intruder = arriveJustBefore(at('To', 'Album'), aFolderArrives(at('To', 'Album')));

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

      expect(intruder.arrived()).toBe(true);
      expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
      expect(result.items[0].to).toBe('To/Album (1)');
      expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
      expect(fs.existsSync(at('From', 'Album'))).toBe(false);
    });

    it('never replaces an empty folder that arrived', async () => {
      await setup(engine);
      seedAlbum();
      arriveJustBefore(at('To', 'Album'), () => fs.mkdirSync(at('To', 'Album')));

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

      expect(names(at('To', 'Album'))).toEqual([]);
      expect(result.items[0].to).toBe('To/Album (1)');
      expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
    });

    /**
     * The folder is renamed over an empty one made for it, and the rename
     * refuses once something is put inside. What was put there stays, and the
     * move takes the next free name, reported as such, rather than failing.
     */
    it('keeps what is put inside the folder made for it, just before the rename', async () => {
      await setup(engine);
      seedAlbum();
      const source = at('From', 'Album');
      const rename = fsp.rename.bind(fsp);
      let filled = false;
      vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (!filled && from === source) {
          filled = true;
          fs.mkdirSync(to, { recursive: true });
          fs.writeFileSync(path.join(to, 'theirs.txt'), 'theirs');
        }
        return rename(from, to);
      });

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

      expect(filled).toBe(true);
      expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
      expect(result.items[0]).toEqual({ from: 'From/Album', to: 'To/Album (1)' });
      expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
      expect(fs.existsSync(source)).toBe(false);
    });

    /**
     * A rename refused with nothing put there leaves no empty folder behind.
     * Refused while its own empty folder is still empty, the filesystem is one
     * that will not rename over an entry at all: that folder goes, and the move
     * keeps its own name by a plain rename, which cannot replace anything there.
     */
    it('leaves no empty folder when the rename is refused with nothing put there', async () => {
      await setup(engine);
      seedAlbum();
      const source = at('From', 'Album');
      const rename = fsp.rename.bind(fsp);
      let refused = false;
      vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (!refused && from === source) {
          refused = true;
          throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
        }
        return rename(from, to);
      });

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

      expect(refused).toBe(true);
      expect(result.items[0].to).toBe('To/Album');
      expect(names(at('To'))).toEqual(['Album']);
      expect(names(at('To', 'Album'))).toEqual(['mine.txt', 'nested']);
    });
  });

  describe('something arriving under the name, the last moment before a move across disks is placed', () => {
    it('keeps a file, and the copied file lands under the next name', async () => {
      await setup(engine);
      fs.writeFileSync(at('From', 'note.txt'), 'mine');
      const intruder = arriveJustBefore(at('To', 'note.txt'), aFileArrives(at('To', 'note.txt')), {
        crossDeviceFrom: at('From', 'note.txt'),
        whenStaged: true,
      });

      const result = await transfer([{ path: 'From', name: 'note.txt' }], 'To', 'move');

      expect(intruder.arrived()).toBe(true);
      expect(read(at('To', 'note.txt'))).toBe('theirs');
      expect(result.items[0].to).toBe('To/note (1).txt');
      expect(read(at('To', 'note (1).txt'))).toBe('mine');
      expect(fs.existsSync(at('From', 'note.txt'))).toBe(false);
      expect(names(at('To'))).toEqual(['note (1).txt', 'note.txt']);
    });

    it('never merges into a folder, and the copied folder lands under the next name', async () => {
      await setup(engine);
      seedAlbum();
      const intruder = arriveJustBefore(at('To', 'Album'), aFolderArrives(at('To', 'Album')), {
        crossDeviceFrom: at('From', 'Album'),
        whenStaged: true,
      });

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

      expect(intruder.arrived()).toBe(true);
      expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
      expect(result.items[0].to).toBe('To/Album (1)');
      expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
      expect(fs.existsSync(at('From', 'Album'))).toBe(false);
      expect(names(at('To'))).toEqual(['Album', 'Album (1)']);
    });
  });

  describe('several copies of one item into one folder at once', () => {
    it('each land whole under a name of their own', async () => {
      await setup(engine);
      const payload = Buffer.alloc(4 * MiB, 7);
      fs.writeFileSync(at('From', 'big.bin'), payload);
      const service = loadService();
      const preps = await Promise.all(
        Array.from({ length: 3 }, () =>
          service.prepareTransfer([{ path: 'From', name: 'big.bin' }], 'To', 'copy', {
            user: ADMIN,
          })
        )
      );

      const results = await Promise.all(
        preps.map((prep) => service.executeTransfer(prep, 'copy', undefined, {}))
      );

      expect(results.map((result) => result.items[0].to).sort()).toEqual([
        'To/big (1).bin',
        'To/big (2).bin',
        'To/big.bin',
      ]);
      expect(names(at('To'))).toEqual(['big (1).bin', 'big (2).bin', 'big.bin']);
      for (const name of names(at('To'))) {
        expect(fs.readFileSync(at('To', name)).equals(payload)).toBe(true);
      }
      expect(journal()).toEqual([]);
    });

    it('each folder lands under a name of its own, never two poured into one', async () => {
      await setup(engine);
      seedAlbum();
      const service = loadService();
      const preps = await Promise.all(
        Array.from({ length: 3 }, () =>
          service.prepareTransfer([{ path: 'From', name: 'Album' }], 'To', 'copy', {
            user: ADMIN,
          })
        )
      );

      const results = await Promise.all(
        preps.map((prep) => service.executeTransfer(prep, 'copy', undefined, {}))
      );

      expect(results.map((result) => result.items[0].to).sort()).toEqual([
        'To/Album',
        'To/Album (1)',
        'To/Album (2)',
      ]);
      expect(names(at('To'))).toEqual(['Album', 'Album (1)', 'Album (2)']);
      for (const name of names(at('To'))) {
        expect(names(at('To', name))).toEqual(['mine.txt', 'nested']);
      }
    });
  });

  describe('a transfer that does not finish', () => {
    it.each(['copy', 'move'])(
      'keeps what a %s has landed when what follows it fails',
      async (operation) => {
        await setup(engine);
        fs.mkdirSync(at('From', 'Empty'));
        const hooks = currentEnv.requireFresh('src/services/folderSizeHooks');
        const failure = Object.assign(new Error('index unavailable'), { code: 'EIO' });
        vi.spyOn(hooks, 'onEntryCopied').mockRejectedValue(failure);
        vi.spyOn(hooks, 'onEntryMoved').mockRejectedValue(failure);

        await expect(
          transfer([{ path: 'From', name: 'Empty' }], 'To', operation)
        ).rejects.toMatchObject({ code: 'EIO' });

        // An empty folder: the transferred entry, and for a move the only one left.
        expect(names(at('To'))).toEqual(['Empty']);
      }
    );

    it.each([
      ['file', 'note.txt'],
      ['folder', 'Album'],
    ])('leaves nothing when a %s copy fails before writing anything', async (_kind, name) => {
      await setup(engine);
      seedAlbum();
      fs.writeFileSync(at('From', 'note.txt'), 'mine');
      // The source goes away the moment the copy first makes its hidden entry.
      let vanished = false;
      const vanish = (candidate) => {
        if (vanished || typeof candidate !== 'string') return;
        if (!STAGING.test(path.basename(candidate.replace(/[/\\]+$/, '')))) return;
        vanished = true;
        fs.rmSync(at('From', name), { recursive: true, force: true });
      };
      for (const method of ['open', 'mkdir']) {
        const original = fsp[method].bind(fsp);
        vi.spyOn(fsp, method).mockImplementation(async (...args) => {
          vanish(args[0]);
          return original(...args);
        });
      }
      const spawn = childProcess.spawn.bind(childProcess);
      vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
        if (command === 'rsync') vanish(args[args.length - 1]);
        return spawn(command, args, options);
      });

      await expect(transfer([{ path: 'From', name }], 'To', 'copy')).rejects.toThrow();

      expect(vanished).toBe(true);
      expect(names(at('To'))).toEqual([]);
      expect(journal()).toEqual([]);
    });

    it('keeps what someone made under the name while the copy ran, when the copy then fails', async () => {
      await setup(engine);
      seedAlbum();
      let made = false;
      const mkdir = fsp.mkdir.bind(fsp);
      vi.spyOn(fsp, 'mkdir').mockImplementation(async (candidate, options) => {
        const result = await mkdir(candidate, options);
        // Just after the hidden folder is made, someone saves a folder under
        // the name, and the copy fails for want of its source.
        if (!made && STAGING.test(path.basename(String(candidate)))) {
          made = true;
          fs.mkdirSync(at('To', 'Album'));
          fs.writeFileSync(at('To', 'Album', 'mine.txt'), 'theirs');
          fs.rmSync(at('From', 'Album'), { recursive: true, force: true });
        }
        return result;
      });

      await expect(transfer([{ path: 'From', name: 'Album' }], 'To', 'copy')).rejects.toThrow();

      expect(made).toBe(true);
      expect(names(at('To'))).toEqual(['Album']);
      expect(names(at('To', 'Album'))).toEqual(['mine.txt']);
      expect(read(at('To', 'Album', 'mine.txt'))).toBe('theirs');
    });
  });

  describe('a move across disks when the removal of the source fails', () => {
    it.each(['file', 'folder'])('keeps the copy of a %s it placed', async (kind) => {
      await setup(engine);
      seedAlbum();
      fs.writeFileSync(at('From', 'note.txt'), 'mine');
      const name = kind === 'file' ? 'note.txt' : 'Album';
      const source = at('From', name);
      acrossDisks(source);
      const failure = Object.assign(new Error('input/output error'), { code: 'EIO' });
      const rm = fsp.rm.bind(fsp);
      vi.spyOn(fsp, 'rm').mockImplementation((candidate, options) =>
        candidate === source ? Promise.reject(failure) : rm(candidate, options)
      );
      const spawn = childProcess.spawn.bind(childProcess);
      vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) =>
        command === 'rm' ? spawn('sh', ['-c', 'exit 1'], options) : spawn(command, args, options)
      );

      await expect(transfer([{ path: 'From', name }], 'To', 'move')).rejects.toThrow();

      expect(names(at('To'))).toEqual([name]);
      if (kind === 'file') expect(read(at('To', 'note.txt'))).toBe('mine');
      else expect(names(at('To', 'Album'))).toEqual(['mine.txt', 'nested']);
      expect(journal()).toEqual([]);
    });
  });

  describe('a symbolic link', () => {
    it('is copied as a link beside what holds its name', async () => {
      await setup(engine);
      fs.writeFileSync(at('From', 'target.txt'), 'pointed at');
      fs.symlinkSync('target.txt', at('From', 'alias.txt'));
      fs.writeFileSync(at('To', 'alias.txt'), 'theirs');

      const result = await transfer([{ path: 'From', name: 'alias.txt' }], 'To', 'copy');

      expect(result.items[0].to).toBe('To/alias (1).txt');
      expect(fs.readlinkSync(at('To', 'alias (1).txt'))).toBe('target.txt');
      expect(read(at('To', 'alias.txt'))).toBe('theirs');
      expect(names(at('To'))).toEqual(['alias (1).txt', 'alias.txt']);
    });

    it('to a folder is copied as the link, as rsync copies it', async () => {
      await setup(engine);
      seedAlbum();
      fs.symlinkSync('Album', at('From', 'shortcut'));

      const result = await transfer([{ path: 'From', name: 'shortcut' }], 'To', 'copy');

      expect(result.items[0].to).toBe('To/shortcut');
      expect(fs.readlinkSync(at('To', 'shortcut'))).toBe('Album');
      expect(names(at('To'))).toEqual(['shortcut']);
    });

    it('to a folder is moved as the link', async () => {
      await setup(engine);
      seedAlbum();
      fs.symlinkSync(at('From', 'Album'), at('From', 'shortcut'));

      const result = await transfer([{ path: 'From', name: 'shortcut' }], 'To', 'move');

      expect(result.items[0].to).toBe('To/shortcut');
      expect(fs.readlinkSync(at('To', 'shortcut'))).toBe(at('From', 'Album'));
      expect(names(at('To'))).toEqual(['shortcut']);
      expect(names(at('From'))).toEqual(['Album']);
    });
  });

  describe('the folder-size hooks', () => {
    const INDEX_HOOKS = [
      'beginDirectoryTransfer',
      'cancelDirectoryTransfer',
      'onEntryCopied',
      'onEntryMoved',
      'onEntryDeleted',
      'refreshTransferredDirectories',
    ];

    /** Every path any index hook is told, spread out of the arrays some take. */
    const spyOnIndexHooks = () => {
      const hooks = currentEnv.requireFresh('src/services/folderSizeHooks');
      const told = [];
      for (const name of INDEX_HOOKS) {
        const original = hooks[name];
        vi.spyOn(hooks, name).mockImplementation((...args) => {
          for (const value of args.flat()) {
            if (typeof value === 'string') told.push({ hook: name, path: value });
          }
          return original(...args);
        });
      }
      return told;
    };

    it.each([
      ['a copy', 'copy', false],
      ['a move', 'move', false],
      ['a move across disks', 'move', true],
    ])('are told where %s of a folder landed, never its hidden name', async (_label, op, xdev) => {
      await setup(engine);
      seedAlbum();
      fs.mkdirSync(at('To', 'Album'));
      if (xdev) acrossDisks(at('From', 'Album'));
      const told = spyOnIndexHooks();

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', op);

      expect(result.items[0].to).toBe('To/Album (1)');
      expect(told.filter((entry) => entry.path.includes('nextexplorer-copying'))).toEqual([]);
      const landed = at('To', 'Album (1)');
      const toldTo = (hook) => told.filter((entry) => entry.hook === hook).map((e) => e.path);
      expect(toldTo('beginDirectoryTransfer')).toEqual([landed]);
      expect(toldTo(op === 'copy' ? 'onEntryCopied' : 'onEntryMoved')).toContain(landed);
      expect(toldTo('refreshTransferredDirectories')).toContain(landed);
      expect(told.some((entry) => entry.path === at('To', 'Album'))).toBe(false);
    });

    it('are told nothing of a folder copy cancelled half-way', async () => {
      await setup(engine);
      const { item } = seedBig('folder');
      const told = spyOnIndexHooks();
      const controller = new AbortController();

      await expect(
        transfer([item], 'To', 'copy', {
          signal: controller.signal,
          onProgress: (progress) => {
            if (moving(progress)) controller.abort();
          },
        })
      ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

      expect(told.filter((entry) => entry.path.includes('nextexplorer-copying'))).toEqual([]);
      expect(told.filter((entry) => entry.hook === 'beginDirectoryTransfer')).toEqual([]);
      expect(names(at('To'))).toEqual([]);
    });

    /**
     * The size walker counts hidden entries like any other. While a folder is
     * filled under its hidden name, scans of the destination are kept away as
     * they were from a visible one; however the copy ends, nothing stays locked,
     * and the hidden folder never has an index entry of its own.
     */
    it.each(['lands', 'is cancelled', 'fails'])(
      'keep scans away from the hidden folder while it fills, and hold nothing once the copy %s',
      async (ending) => {
        await setup(engine, { folderSize: 'full' });
        const { item } = seedBig('folder');
        const index = await currentEnv.requireFresh('src/services/indexDb').getIndexDb();
        const folderSizeIndex = currentEnv.requireFresh('src/services/folderSizeIndex');
        currentEnv.requireFresh('src/services/folderSizeHooks');
        // eslint-disable-next-line global-require
        const transferState = require(modulePath('src/services/folderSizeTransferState'));
        const controller = new AbortController();
        let during = null;
        if (ending === 'fails') {
          // rsync reads the files itself: it fails after one progress report.
          const spawn = childProcess.spawn.bind(childProcess);
          vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) =>
            command === 'rsync'
              ? spawn('sh', ['-c', 'printf "  1,024  10%%\\n"; exit 12'], options)
              : spawn(command, args, options)
          );
          const createReadStream = fs.createReadStream.bind(fs);
          vi.spyOn(fs, 'createReadStream').mockImplementation((candidate, options) => {
            if (candidate !== at('From', 'big', 'part-2.bin')) {
              return createReadStream(candidate, options);
            }
            return new Readable({
              read() {
                this.destroy(Object.assign(new Error('input/output error'), { code: 'EIO' }));
              },
            });
          });
        }

        const running = transfer([item], 'To', 'copy', {
          signal: controller.signal,
          onProgress: (progress) => {
            if (during || !moving(progress)) return;
            const [staging] = recordedPaths();
            during = {
              staging,
              destinationKeptAway: transferState.isRelatedToActiveTransfer(at('To')),
            };
            if (ending === 'is cancelled') controller.abort();
          },
        });
        if (ending === 'lands') await running;
        else await expect(running).rejects.toThrow();

        expect(during.destinationKeptAway).toBe(true);
        expect(transferState.isRelatedToActiveTransfer(during.staging)).toBe(false);
        await vi.waitFor(() =>
          expect(transferState.isRelatedToActiveTransfer(at('To'))).toBe(false)
        );
        expect(folderSizeIndex.getByAbsolutePath(index, during.staging)).toBeFalsy();
        expect(hidden(at('To'))).toEqual([]);
      }
    );
  });
});

describe('a copy that fails while writing', () => {
  const failingRead = (failing) => {
    const createReadStream = fs.createReadStream.bind(fs);
    vi.spyOn(fs, 'createReadStream').mockImplementation((candidate, options) => {
      if (candidate !== failing) return createReadStream(candidate, options);
      return new Readable({
        read() {
          this.push(Buffer.from('half of it'));
          this.destroy(Object.assign(new Error('input/output error'), { code: 'EIO' }));
        },
      });
    });
  };

  it('of a file leaves no hidden entry and nothing under its name', async () => {
    await setup('stream');
    fs.writeFileSync(at('From', 'note.txt'), 'mine');
    failingRead(at('From', 'note.txt'));

    await expect(
      transfer([{ path: 'From', name: 'note.txt' }], 'To', 'copy')
    ).rejects.toMatchObject({ code: 'EIO' });

    expect(names(at('To'))).toEqual([]);
    expect(journal()).toEqual([]);
  });

  /** A hidden half-folder is nothing a person could look into, so it goes too. */
  it('of a folder, once part of it is written, leaves no hidden entry and nothing under its name', async () => {
    await setup('stream');
    seedBig('folder');
    failingRead(at('From', 'big', 'part-2.bin'));

    await expect(transfer([{ path: 'From', name: 'big' }], 'To', 'copy')).rejects.toMatchObject({
      code: 'EIO',
    });

    expect(names(at('To'))).toEqual([]);
    expect(journal()).toEqual([]);
  });
});

describe('a move across disks stopped while the source is removed', () => {
  /**
   * The copy is whole by then, and `rm` may already have taken part of the
   * source. Cancelling must never remove the only whole copy.
   */
  it('keeps the whole copy', async () => {
    await setup('native');
    seedAlbum();
    const source = at('From', 'Album');
    acrossDisks(source);
    const controller = new AbortController();
    const spawn = childProcess.spawn.bind(childProcess);
    vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      if (command !== 'rm') return spawn(command, args, options);
      // Part of the source is gone, and the removal is still running when the
      // transfer is cancelled.
      fs.rmSync(path.join(source, 'mine.txt'));
      setTimeout(() => controller.abort(), 50);
      return spawn('sleep', ['5'], options);
    });

    await expect(
      transfer([{ path: 'From', name: 'Album' }], 'To', 'move', { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

    expect(names(at('To'))).toEqual(['Album']);
    expect(names(at('To', 'Album'))).toEqual(['mine.txt', 'nested']);
    expect(read(at('To', 'Album', 'nested', 'deep.txt'))).toBe('deep');
  });
});
