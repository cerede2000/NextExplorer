import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A copy or a move never replaces, nor merges into, what arrives under its name.
 *
 * The transfer looked for a free name — "note (1).txt" — and wrote under it
 * afterwards: copyFile, a recursive copy for a folder, a rename for a move.
 * Whatever arrived under that name in between, another copy or a file saved
 * over SMB, was replaced by the file, poured into by the folder, or replaced by
 * the rename; and a copy lasting minutes held that gap open for minutes.
 *
 * Each test here puts something under the name at the worst moment: just
 * before the transfer first creates, links or renames anything at that name.
 * What arrived must stay as it was, and the transfer must land under the next
 * name and say so.
 */

let currentEnv;

const ADMIN = { id: 'admin', roles: ['admin'] };

afterEach(async () => {
  vi.restoreAllMocks();
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const at = (...segments) => path.join(currentEnv.volumeDir, ...segments);

const setup = async () => {
  currentEnv = await setupTestEnv({ tag: 'transfer-no-overwrite-' });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
  ).run(now, now);
  fs.mkdirSync(at('From'), { recursive: true });
  fs.mkdirSync(at('To'), { recursive: true });
};

const transfer = (items, destination, operation) =>
  currentEnv
    .requireFresh('src/services/fileTransferService')
    .transferItems(items, destination, operation, { user: ADMIN });

const names = (directory) => fs.readdirSync(directory).sort();
const read = (file) => fs.readFileSync(file, 'utf8');

const journal = () => path.join(currentEnv.cacheDir, 'in-flight');
const records = () =>
  fs.existsSync(journal()) ? fs.readdirSync(journal()).filter((n) => n.endsWith('.json')) : [];

/**
 * Run `arrive` the moment the transfer first creates, links or renames onto
 * the path `target`, just before it does. Whatever the transfer looked at to
 * choose that name, the name was free then and is taken now.
 *
 * `crossDeviceFrom` makes the link or rename of that source report EXDEV, as a
 * move to another disk does; it lives here because both need the same spies.
 */
const arriveJustBefore = (target, arrive, { crossDeviceFrom } = {}) => {
  let arrived = false;
  const touch = (candidate) => {
    if (arrived || typeof candidate !== 'string') return;
    if (candidate.replace(/[/\\]+$/, '') !== target) return;
    arrived = true;
    arrive();
  };

  for (const [method, pathIndex] of [
    ['open', 0],
    ['mkdir', 0],
    ['writeFile', 0],
    ['copyFile', 1],
    ['cp', 1],
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

  return { arrived: () => arrived };
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

describe('a copy meeting something that arrives under its name', () => {
  it('keeps a file, and the copy lands under the next name', async () => {
    await setup();
    fs.writeFileSync(at('From', 'note.txt'), 'mine');
    const intruder = arriveJustBefore(at('To', 'note.txt'), aFileArrives(at('To', 'note.txt')));

    const result = await transfer([{ path: 'From', name: 'note.txt' }], 'To', 'copy');

    expect(intruder.arrived()).toBe(true);
    expect(read(at('To', 'note.txt'))).toBe('theirs');
    expect(result.items[0].to).toBe('To/note (1).txt');
    expect(read(at('To', 'note (1).txt'))).toBe('mine');
    // Nothing else: no hidden copy left beside them.
    expect(names(at('To'))).toEqual(['note (1).txt', 'note.txt']);
  });

  it('never merges into a folder, and the copy lands under the next name', async () => {
    await setup();
    seedAlbum();
    const intruder = arriveJustBefore(at('To', 'Album'), aFolderArrives(at('To', 'Album')));

    const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'copy');

    expect(intruder.arrived()).toBe(true);
    expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
    expect(result.items[0].to).toBe('To/Album (1)');
    expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
    expect(read(at('To', 'Album (1)', 'nested', 'deep.txt'))).toBe('deep');
    expect(names(at('To'))).toEqual(['Album', 'Album (1)']);
  });

  it('gives three copies of one file at once a name each', async () => {
    await setup();
    fs.writeFileSync(at('From', 'note.txt'), 'mine');

    const results = await Promise.all(
      [1, 2, 3].map(() => transfer([{ path: 'From', name: 'note.txt' }], 'To', 'copy'))
    );

    expect(results.map((result) => result.items[0].to).sort()).toEqual([
      'To/note (1).txt',
      'To/note (2).txt',
      'To/note.txt',
    ]);
    expect(names(at('To'))).toEqual(['note (1).txt', 'note (2).txt', 'note.txt']);
    for (const name of names(at('To'))) expect(read(at('To', name))).toBe('mine');
  });
});

describe('a move meeting something that arrives under its name, on one disk', () => {
  it('keeps a file, and the moved file lands under the next name', async () => {
    await setup();
    fs.writeFileSync(at('From', 'note.txt'), 'mine');
    arriveJustBefore(at('To', 'note.txt'), aFileArrives(at('To', 'note.txt')));

    const result = await transfer([{ path: 'From', name: 'note.txt' }], 'To', 'move');

    expect(read(at('To', 'note.txt'))).toBe('theirs');
    expect(result.items[0]).toEqual({ from: 'From/note.txt', to: 'To/note (1).txt' });
    expect(read(at('To', 'note (1).txt'))).toBe('mine');
    expect(fs.existsSync(at('From', 'note.txt'))).toBe(false);
    expect(names(at('To'))).toEqual(['note (1).txt', 'note.txt']);
  });

  it('keeps a folder with something in it, and the moved folder lands under the next name', async () => {
    await setup();
    seedAlbum();
    arriveJustBefore(at('To', 'Album'), aFolderArrives(at('To', 'Album')));

    const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

    expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
    expect(result.items[0].to).toBe('To/Album (1)');
    expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
    expect(fs.existsSync(at('From', 'Album'))).toBe(false);
  });

  /** rename(2) replaces an empty folder without a word. */
  it('never replaces an empty folder that arrived', async () => {
    await setup();
    seedAlbum();
    arriveJustBefore(at('To', 'Album'), () => fs.mkdirSync(at('To', 'Album')));

    const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

    expect(names(at('To', 'Album'))).toEqual([]);
    expect(result.items[0].to).toBe('To/Album (1)');
    expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
  });
});

describe('a move to another disk', () => {
  it('keeps a file that arrives under the name, and the source goes once the copy is in place', async () => {
    await setup();
    fs.writeFileSync(at('From', 'note.txt'), 'mine');
    arriveJustBefore(at('To', 'note.txt'), aFileArrives(at('To', 'note.txt')), {
      crossDeviceFrom: at('From', 'note.txt'),
    });

    const result = await transfer([{ path: 'From', name: 'note.txt' }], 'To', 'move');

    expect(read(at('To', 'note.txt'))).toBe('theirs');
    expect(result.items[0].to).toBe('To/note (1).txt');
    expect(read(at('To', 'note (1).txt'))).toBe('mine');
    expect(fs.existsSync(at('From', 'note.txt'))).toBe(false);
    expect(names(at('To'))).toEqual(['note (1).txt', 'note.txt']);
    expect(records()).toEqual([]);
  });

  it('never merges a folder into one that arrives under its name', async () => {
    await setup();
    seedAlbum();
    arriveJustBefore(at('To', 'Album'), aFolderArrives(at('To', 'Album')), {
      crossDeviceFrom: at('From', 'Album'),
    });

    const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

    expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
    expect(result.items[0].to).toBe('To/Album (1)');
    expect(read(at('To', 'Album (1)', 'nested', 'deep.txt'))).toBe('deep');
    expect(fs.existsSync(at('From', 'Album'))).toBe(false);
    expect(names(at('To'))).toEqual(['Album', 'Album (1)']);
  });

  it('keeps the source when the copy fails, and leaves nothing half-written', async () => {
    await setup();
    seedAlbum();
    const cp = fsp.cp.bind(fsp);
    vi.spyOn(fsp, 'rename').mockRejectedValue(
      Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
    );
    vi.spyOn(fsp, 'cp').mockImplementation(async (from, to, options) => {
      await cp(from, to, options);
      throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    });

    await expect(transfer([{ path: 'From', name: 'Album' }], 'To', 'move')).rejects.toThrow(
      /No space left/
    );

    expect(names(at('From', 'Album'))).toEqual(['mine.txt', 'nested']);
    expect(names(at('To'))).toEqual([]);
    expect(records()).toEqual([]);
  });
});

describe('a copy on its way', () => {
  /**
   * The copy is written under a hidden name of its own, recorded while it is
   * written: a stop half way has the next start remove it, and never anything
   * under the name the copy was meant to take.
   */
  it('is a hidden entry, recorded until it is in place', async () => {
    await setup();
    seedAlbum();
    const cp = fsp.cp.bind(fsp);
    let seen = null;
    vi.spyOn(fsp, 'cp').mockImplementation(async (from, to, options) => {
      await cp(from, to, options);
      seen = {
        listing: names(at('To')),
        recorded: records().map((name) => JSON.parse(read(path.join(journal(), name)))),
      };
    });

    await transfer([{ path: 'From', name: 'Album' }], 'To', 'copy');

    expect(seen.listing).toEqual([expect.stringMatching(/^\.nextexplorer-copy-/)]);
    expect(seen.recorded).toEqual([
      expect.objectContaining({ path: at('To', seen.listing[0]), kind: 'partial-copy' }),
    ]);
    expect(names(at('To'))).toEqual(['Album']);
    expect(records()).toEqual([]);
  });

  it('that fails leaves neither the hidden copy nor anything under the name', async () => {
    await setup();
    fs.writeFileSync(at('From', 'note.txt'), 'mine');
    const copyFile = fsp.copyFile.bind(fsp);
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      await copyFile(from, to, mode);
      throw Object.assign(new Error('Input/output error'), { code: 'EIO' });
    });

    await expect(transfer([{ path: 'From', name: 'note.txt' }], 'To', 'copy')).rejects.toThrow(
      /Input\/output error/
    );

    expect(names(at('To'))).toEqual([]);
    expect(records()).toEqual([]);
  });
});
