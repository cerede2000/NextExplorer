import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath } from '../helpers/env-test-utils.js';

/**
 * Placing something under a name without ever replacing what holds it.
 *
 * Every operation that picked a free name and wrote under it later could
 * replace a file that arrived under that name in between. The name is now
 * taken by an operation that fails when it is already held, and each test
 * below puts something under the name at the worst moment.
 */

let root;
let place;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextexplorer-place-'));
  place = require(modulePath('src/utils/placeWithoutOverwrite'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const file = (name, content) => {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};

const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const names = (dir = '') => fs.readdirSync(path.join(root, dir)).sort();

/** link(2) refused as a filesystem without hard links refuses it. */
const withoutHardLinks = () =>
  vi
    .spyOn(fsp, 'link')
    .mockRejectedValue(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));

describe('placing a file', () => {
  it('takes the name when it is free, and the source is gone', async () => {
    const source = file('.upload-1.uploading', 'new');

    await expect(place.placeWithoutOverwrite(source, root, 'report.pdf')).resolves.toEqual({
      name: 'report.pdf',
      path: path.join(root, 'report.pdf'),
    });

    expect(names()).toEqual(['report.pdf']);
    expect(read('report.pdf')).toBe('new');
  });

  it('never replaces a file already there, and takes the next name', async () => {
    file('report.pdf', 'someone else’s');
    file('report (1).pdf', 'another');
    const source = file('.upload-1.uploading', 'new');

    const placed = await place.placeWithoutOverwrite(source, root, 'report.pdf');

    expect(placed.name).toBe('report (2).pdf');
    expect(read('report.pdf')).toBe('someone else’s');
    expect(read('report (1).pdf')).toBe('another');
    expect(read('report (2).pdf')).toBe('new');
  });

  it('keeps a file that arrives under the name at the last moment', async () => {
    const source = file('.upload-1.uploading', 'new');
    // The name is free when the placement starts, and taken just before the
    // move that would have replaced it.
    const link = fsp.link.bind(fsp);
    vi.spyOn(fsp, 'link').mockImplementationOnce(async (from, to) => {
      fs.writeFileSync(to, 'arrived meanwhile');
      return link(from, to);
    });

    const placed = await place.placeWithoutOverwrite(source, root, 'report.pdf');

    expect(read('report.pdf')).toBe('arrived meanwhile');
    expect(placed.name).toBe('report (1).pdf');
    expect(read('report (1).pdf')).toBe('new');
    expect(fs.existsSync(source)).toBe(false);
  });

  it('keeps a file that arrives at the last moment where there are no hard links', async () => {
    withoutHardLinks();
    const source = file('.upload-1.uploading', 'new');
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementationOnce(async (target, flags) => {
      fs.writeFileSync(target, 'arrived meanwhile');
      return open(target, flags);
    });

    const placed = await place.placeWithoutOverwrite(source, root, 'report.pdf');

    expect(read('report.pdf')).toBe('arrived meanwhile');
    expect(placed.name).toBe('report (1).pdf');
    expect(read('report (1).pdf')).toBe('new');
    expect(names()).toEqual(['report (1).pdf', 'report.pdf']);
  });

  it('never replaces a dangling link holding the name', async () => {
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'report.pdf'));
    const source = file('.upload-1.uploading', 'new');

    const placed = await place.placeWithoutOverwrite(source, root, 'report.pdf');

    expect(placed.name).toBe('report (1).pdf');
    expect(fs.lstatSync(path.join(root, 'report.pdf')).isSymbolicLink()).toBe(true);
  });

  it('moves a symbolic link itself, not what it points at', async () => {
    const target = file('elsewhere.txt', 'pointed at');
    const source = path.join(root, 'staged-link');
    fs.symlinkSync(target, source);
    file('link', 'already here');

    const placed = await place.placeWithoutOverwrite(source, root, 'link');

    expect(placed.name).toBe('link (1)');
    expect(fs.readlinkSync(path.join(root, 'link (1)'))).toBe(target);
    expect(read('link')).toBe('already here');
  });

  it('lets a move across filesystems fail as such, leaving both sides as they were', async () => {
    const source = file('.upload-1.uploading', 'new');
    vi.spyOn(fsp, 'link').mockRejectedValue(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    );

    await expect(place.placeWithoutOverwrite(source, root, 'report.pdf')).rejects.toMatchObject({
      code: 'EXDEV',
    });
    expect(names()).toEqual(['.upload-1.uploading']);
  });

  it('leaves no placeholder behind when the move itself fails', async () => {
    withoutHardLinks();
    const source = file('.upload-1.uploading', 'new');
    vi.spyOn(fsp, 'rename').mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    );

    await expect(place.placeWithoutOverwrite(source, root, 'report.pdf')).rejects.toMatchObject({
      code: 'EACCES',
    });
    expect(names()).toEqual(['.upload-1.uploading']);
  });

  it('never removes what someone wrote into the placeholder when the move then fails', async () => {
    withoutHardLinks();
    const source = file('.upload-1.uploading', 'new');
    vi.spyOn(fsp, 'rename').mockImplementation(async (_from, to) => {
      fs.writeFileSync(to, 'written into it meanwhile');
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    await expect(place.placeWithoutOverwrite(source, root, 'report.pdf')).rejects.toMatchObject({
      code: 'EACCES',
    });
    expect(read('report.pdf')).toBe('written into it meanwhile');
  });
});

describe('placing a folder', () => {
  it('never merges into or replaces a folder already there', async () => {
    file('Photos/theirs.jpg', 'theirs');
    const source = path.join(root, '.staging');
    file('.staging/mine.jpg', 'mine');

    const placed = await place.placeWithoutOverwrite(source, root, 'Photos');

    expect(placed.name).toBe('Photos (1)');
    expect(names('Photos')).toEqual(['theirs.jpg']);
    expect(names('Photos (1)')).toEqual(['mine.jpg']);
  });

  it('never replaces an empty folder already there', async () => {
    fs.mkdirSync(path.join(root, 'Photos'));
    const source = path.join(root, '.staging');
    file('.staging/mine.jpg', 'mine');

    const placed = await place.placeWithoutOverwrite(source, root, 'Photos');

    expect(placed.name).toBe('Photos (1)');
    expect(names('Photos')).toEqual([]);
  });

  it('keeps what is put inside the name between its creation and the move', async () => {
    const source = path.join(root, '.staging');
    file('.staging/mine.jpg', 'mine');
    const mkdir = fsp.mkdir.bind(fsp);
    vi.spyOn(fsp, 'mkdir').mockImplementationOnce(async (target, options) => {
      await mkdir(target, options);
      fs.writeFileSync(path.join(target, 'theirs.jpg'), 'theirs');
    });

    const placed = await place.placeWithoutOverwrite(source, root, 'Photos');

    expect(names('Photos')).toEqual(['theirs.jpg']);
    expect(placed.name).toBe('Photos (1)');
    expect(names('Photos (1)')).toEqual(['mine.jpg']);
  });

  it('names the next one as a new folder is named, when asked', async () => {
    fs.mkdirSync(path.join(root, 'Untitled Folder'));
    const source = path.join(root, '.staging');
    fs.mkdirSync(source);

    const placed = await place.placeWithoutOverwrite(source, root, 'Untitled Folder', {
      style: 'folder',
    });

    expect(placed.name).toBe('Untitled Folder 2');
  });
});

describe('moving to exactly one name', () => {
  it('refuses with EEXIST when the name is taken, and moves nothing', async () => {
    file('report.pdf', 'theirs');
    const source = file('.payload', 'mine');

    await expect(place.moveNoReplace(source, path.join(root, 'report.pdf'))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(read('report.pdf')).toBe('theirs');
    expect(read('.payload')).toBe('mine');
  });
});

describe('reserving a name', () => {
  it('gives each of several at once a different name, and never one already there', async () => {
    file('notes.txt', 'theirs');

    const reserved = await Promise.all(
      Array.from({ length: 6 }, () => place.reserveAvailableName(root, 'notes.txt'))
    );

    const taken = reserved.map((entry) => entry.name).sort();
    expect(new Set(taken).size).toBe(6);
    expect(taken).not.toContain('notes.txt');
    expect(read('notes.txt')).toBe('theirs');
  });

  it('holds a folder name with an empty folder', async () => {
    fs.mkdirSync(path.join(root, 'Archive'));

    const reserved = await place.reserveAvailableName(root, 'Archive', { isDirectory: true });

    expect(reserved.name).toBe('Archive (1)');
    expect(fs.statSync(reserved.path).isDirectory()).toBe(true);
  });
});

describe('a filesystem that refuses to rename over an existing entry', () => {
  /**
   * Some FUSE mounts and SMB shares refuse a rename over anything already
   * there, even the empty placeholder the move created itself. Every name then
   * looked taken, and a placement walked "(1)", "(2)"… ten thousand times
   * before giving up. Once its own empty placeholder is removed, a plain rename
   * is the move there: it cannot replace anything on such a filesystem.
   */
  const refusingRenameOverEntries = () => {
    const rename = fsp.rename.bind(fsp);
    const calls = [];
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      calls.push(to);
      if (fs.existsSync(to)) {
        throw Object.assign(new Error('file already exists'), { code: 'EEXIST' });
      }
      return rename(from, to);
    });
    return calls;
  };

  it('places a folder under its own name', async () => {
    const calls = refusingRenameOverEntries();
    const source = path.join(root, '.staging');
    file('.staging/mine.jpg', 'mine');

    const placed = await place.placeWithoutOverwrite(source, root, 'Photos');

    expect(placed.name).toBe('Photos');
    expect(names('Photos')).toEqual(['mine.jpg']);
    expect(calls.every((to) => to === path.join(root, 'Photos'))).toBe(true);
  });

  it('places a file under its own name where there are no hard links', async () => {
    withoutHardLinks();
    refusingRenameOverEntries();
    const source = file('.upload-1.uploading', 'new');

    const placed = await place.placeWithoutOverwrite(source, root, 'report.pdf');

    expect(placed.name).toBe('report.pdf');
    expect(read('report.pdf')).toBe('new');
    expect(names()).toEqual(['report.pdf']);
  });

  it('still moves past a folder someone filled between its creation and the move', async () => {
    refusingRenameOverEntries();
    const source = path.join(root, '.staging');
    file('.staging/mine.jpg', 'mine');
    const mkdir = fsp.mkdir.bind(fsp);
    vi.spyOn(fsp, 'mkdir').mockImplementationOnce(async (target, options) => {
      await mkdir(target, options);
      fs.writeFileSync(path.join(target, 'theirs.jpg'), 'theirs');
    });

    const placed = await place.placeWithoutOverwrite(source, root, 'Photos');

    expect(names('Photos')).toEqual(['theirs.jpg']);
    expect(placed.name).toBe('Photos (1)');
    expect(names('Photos (1)')).toEqual(['mine.jpg']);
  });
});

describe('moving a symbolic link', () => {
  it('makes the link again under a free name, with no empty file ever holding the name', async () => {
    const target = file('elsewhere.txt', 'pointed at');
    const source = path.join(root, 'staged-link');
    fs.symlinkSync('elsewhere.txt', source);
    file('link', 'already here');
    const open = vi.spyOn(fsp, 'open');

    const placed = await place.placeWithoutOverwrite(source, root, 'link');

    expect(placed.name).toBe('link (1)');
    expect(fs.readlinkSync(path.join(root, 'link (1)'))).toBe('elsewhere.txt');
    expect(fs.readFileSync(path.join(root, 'link (1)'), 'utf8')).toBe('pointed at');
    expect(read('link')).toBe('already here');
    expect(fs.lstatSync(source, { throwIfNoEntry: false })).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, 'utf8')).toBe('pointed at');
  });
});
