import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A copy or a move never replaces, nor merges into, what arrives under its name.
 *
 * The transfer looked for a free name — "note (1).txt" — and wrote under it
 * afterwards: a file stream opened with truncation, rsync, a recursive mkdir
 * for a folder, a rename for a move. Whatever arrived under that name in
 * between, another copy or a file saved over SMB, was replaced by the file,
 * poured into by the folder, or replaced by the rename; and a copy lasting
 * minutes held that gap open for minutes.
 *
 * Each test here puts something under the name at the worst moment: just
 * before the transfer first creates, writes or renames anything at the name it
 * chose. What arrived must stay as it was, and the transfer must land under the
 * next name and say so. Both engines run every case; where rsync cannot run
 * (macOS ships one too old for it), the native engine falls back to streams
 * for the copy and still removes with `rm`.
 */

let currentEnv;

const ENGINES = ['native', 'stream'];
const ADMIN = { id: 'admin', roles: ['admin'] };

afterEach(async () => {
  vi.restoreAllMocks();
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const at = (...segments) => path.join(currentEnv.volumeDir, ...segments);

const setup = async (engine) => {
  currentEnv = await setupTestEnv({
    tag: `transfer-no-overwrite-${engine}-`,
    env: { FILE_TRANSFER_ENGINE: engine, FOLDER_SIZE_MODE: 'off' },
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

/**
 * Run `arrive` the moment the transfer first creates, writes, renames onto or
 * hands rsync the path `target`, just before it does. Whatever the transfer
 * looked at to choose that name, the name was free then and is taken now.
 *
 * `crossDeviceFrom` makes the rename of that source report EXDEV, as a move to
 * another disk does; it lives here because both need the one rename spy.
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
    ['symlink', 1],
    ['link', 1],
    ['rename', 1],
  ]) {
    const original = fsp[method].bind(fsp);
    vi.spyOn(fsp, method).mockImplementation(async (...args) => {
      touch(args[pathIndex]);
      if (method === 'rename' && crossDeviceFrom && args[0] === crossDeviceFrom) {
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

describe.each(ENGINES)('with the %s engine', (engine) => {
  describe('a file arriving under the name a copy chose', () => {
    it('is kept, and the copy lands under the next name', async () => {
      await setup(engine);
      fs.writeFileSync(at('From', 'note.txt'), 'mine');
      const intruder = arriveJustBefore(at('To', 'note.txt'), aFileArrives(at('To', 'note.txt')));

      const result = await transfer([{ path: 'From', name: 'note.txt' }], 'To', 'copy');

      expect(intruder.arrived()).toBe(true);
      expect(read(at('To', 'note.txt'))).toBe('theirs');
      expect(result.items[0].to).toBe('To/note (1).txt');
      expect(read(at('To', 'note (1).txt'))).toBe('mine');
      // Nothing else: no placeholder or partial file left beside them.
      expect(names(at('To'))).toEqual(['note (1).txt', 'note.txt']);
    });
  });

  describe('a folder arriving under the name a copy chose', () => {
    it('is never merged into, and the copy lands under the next name', async () => {
      await setup(engine);
      seedAlbum();
      const intruder = arriveJustBefore(at('To', 'Album'), aFolderArrives(at('To', 'Album')));

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'copy');

      expect(intruder.arrived()).toBe(true);
      expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
      expect(result.items[0].to).toBe('To/Album (1)');
      expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
      expect(read(at('To', 'Album (1)', 'nested', 'deep.txt'))).toBe('deep');
    });
  });

  describe('something arriving under the name a move chose, on one disk', () => {
    it('keeps a file, and the moved file lands under the next name', async () => {
      await setup(engine);
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
      await setup(engine);
      seedAlbum();
      arriveJustBefore(at('To', 'Album'), aFolderArrives(at('To', 'Album')));

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

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
     * The name is held by an empty folder, and the rename onto it refuses once
     * something is put inside. What was put there stays, and the move takes the
     * next free name, reported as such, rather than failing.
     */
    it('keeps what is put inside the reserved folder just before the rename', async () => {
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
     * Some filesystems refuse a rename over an empty folder. Nothing was put in
     * the reserved one, so it is removed and the name taken again, rather than
     * left behind, empty, beside the moved folder.
     */
    it('takes its name again when the rename is refused with nothing put there', async () => {
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

  describe('something arriving under the name a move chose, across disks', () => {
    it('keeps a file, and the copied file lands under the next name', async () => {
      await setup(engine);
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
    });

    it('never merges into a folder, and the copied folder lands under the next name', async () => {
      await setup(engine);
      seedAlbum();
      arriveJustBefore(at('To', 'Album'), aFolderArrives(at('To', 'Album')), {
        crossDeviceFrom: at('From', 'Album'),
      });

      const result = await transfer([{ path: 'From', name: 'Album' }], 'To', 'move');

      expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
      expect(result.items[0].to).toBe('To/Album (1)');
      expect(names(at('To', 'Album (1)'))).toEqual(['mine.txt', 'nested']);
      expect(fs.existsSync(at('From', 'Album'))).toBe(false);
    });
  });

  describe('several copies of one item into one folder at once', () => {
    it('each land whole under a name of their own', async () => {
      await setup(engine);
      const payload = Buffer.alloc(4 * 1024 * 1024, 7);
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
      for (const name of names(at('To'))) {
        expect(names(at('To', name))).toEqual(['mine.txt', 'nested']);
      }
    });
  });

  describe('a transfer that does not finish', () => {
    it('leaves nothing behind when a file copy is cancelled', async () => {
      await setup(engine);
      fs.writeFileSync(at('From', 'big.bin'), Buffer.alloc(32 * 1024 * 1024, 3));
      const controller = new AbortController();

      await expect(
        transfer([{ path: 'From', name: 'big.bin' }], 'To', 'copy', {
          signal: controller.signal,
          onProgress: ({ copiedBytes }) => {
            if (copiedBytes > 0) controller.abort();
          },
        })
      ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

      expect(names(at('To'))).toEqual([]);
    });

    it('leaves nothing behind when cancelled before anything is written', async () => {
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

    it.each(['copy', 'move'])(
      'never removes what was put in the reserved folder when a %s is cancelled before writing',
      async (operation) => {
        await setup(engine);
        seedAlbum();
        const controller = new AbortController();

        await expect(
          transfer([{ path: 'From', name: 'Album' }], 'To', operation, {
            signal: controller.signal,
            // The first report comes once the name is taken, before any write.
            onProgress: () => {
              if (controller.signal.aborted) return;
              fs.writeFileSync(at('To', 'Album', 'theirs.txt'), 'theirs');
              controller.abort();
            },
          })
        ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

        expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
        expect(names(at('From', 'Album'))).toEqual(['mine.txt', 'nested']);
      }
    );

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

        // An empty folder is exactly what a placeholder looks like; this one
        // is the transferred entry, and for a move the only one left.
        expect(names(at('To'))).toEqual(['Empty']);
      }
    );

    it('gives the name back when a file copy fails before writing anything', async () => {
      await setup(engine);
      fs.writeFileSync(at('From', 'note.txt'), 'mine');
      // The source goes away at the moment the copy first touches its name.
      arriveJustBefore(at('To', 'note.txt'), () => fs.rmSync(at('From', 'note.txt')));

      await expect(transfer([{ path: 'From', name: 'note.txt' }], 'To', 'copy')).rejects.toThrow();

      expect(names(at('To'))).toEqual([]);
    });

    it('gives the name back when a folder copy fails before writing anything', async () => {
      await setup(engine);
      seedAlbum();
      arriveJustBefore(at('To', 'Album'), () =>
        fs.rmSync(at('From', 'Album'), { recursive: true, force: true })
      );

      await expect(transfer([{ path: 'From', name: 'Album' }], 'To', 'copy')).rejects.toThrow();

      expect(names(at('To'))).toEqual([]);
    });

    it('never removes what someone put in the reserved folder when the copy then fails', async () => {
      await setup(engine);
      seedAlbum();
      const mkdir = fsp.mkdir.bind(fsp);
      vi.spyOn(fsp, 'mkdir').mockImplementation(async (candidate, options) => {
        const made = await mkdir(candidate, options);
        // Just after the name is taken, something is saved into the folder,
        // and the copy fails for want of its source.
        if (candidate === at('To', 'Album') && options === undefined) {
          fs.writeFileSync(at('To', 'Album', 'theirs.txt'), 'theirs');
          fs.rmSync(at('From', 'Album'), { recursive: true, force: true });
        }
        return made;
      });

      await expect(transfer([{ path: 'From', name: 'Album' }], 'To', 'copy')).rejects.toThrow();

      expect(names(at('To'))).toEqual(['Album']);
      expect(names(at('To', 'Album'))).toEqual(['theirs.txt']);
    });
  });

  describe('a symbolic link', () => {
    it('is copied as a link over the placeholder holding its name', async () => {
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
});

describe('a file copy that fails while writing', () => {
  it('removes its partial file and gives the name back', async () => {
    await setup('stream');
    fs.writeFileSync(at('From', 'note.txt'), 'mine');
    const createReadStream = fs.createReadStream.bind(fs);
    vi.spyOn(fs, 'createReadStream').mockImplementation((candidate, options) => {
      if (candidate !== at('From', 'note.txt')) return createReadStream(candidate, options);
      return new Readable({
        read() {
          this.push(Buffer.from('half of it'));
          this.destroy(Object.assign(new Error('input/output error'), { code: 'EIO' }));
        },
      });
    });

    await expect(
      transfer([{ path: 'From', name: 'note.txt' }], 'To', 'copy')
    ).rejects.toMatchObject({ code: 'EIO' });

    expect(names(at('To'))).toEqual([]);
  });
});

describe('a folder transfer cancelled once some of it is written', () => {
  /**
   * Streams only: the moment to cancel is when the copy opens its second file,
   * which rsync does out of sight. A cancelled copy removes the file it was
   * writing, so the folder it leaves is a partial copy to remove only once a
   * whole file has landed in it — as it has by then.
   */
  it.each([
    ['copy', {}],
    ['move across disks', { crossDevice: true }],
  ])('removes its partial copy after a %s, and keeps the source', async (_label, options) => {
    await setup('stream');
    fs.mkdirSync(at('From', 'big'));
    for (let index = 0; index < 3; index += 1) {
      fs.writeFileSync(at('From', 'big', `part-${index}.bin`), Buffer.alloc(1024 * 1024, index));
    }
    if (options.crossDevice) {
      const rename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (from === at('From', 'big')) {
          throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
        }
        return rename(from, to);
      });
    }
    const controller = new AbortController();
    let landedBeforeCancel = [];
    let opened = 0;
    const createReadStream = fs.createReadStream.bind(fs);
    vi.spyOn(fs, 'createReadStream').mockImplementation((candidate, streamOptions) => {
      if (String(candidate).startsWith(`${at('From', 'big')}${path.sep}`)) {
        opened += 1;
        if (opened === 2) {
          landedBeforeCancel = names(at('To', 'big'));
          controller.abort();
        }
      }
      return createReadStream(candidate, streamOptions);
    });

    await expect(
      transfer([{ path: 'From', name: 'big' }], 'To', options.crossDevice ? 'move' : 'copy', {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

    expect(landedBeforeCancel.length).toBeGreaterThan(0);
    expect(names(at('To'))).toEqual([]);
    expect(names(at('From', 'big'))).toEqual(['part-0.bin', 'part-1.bin', 'part-2.bin']);
  });
});

describe('the partial file written beside a reserved name', () => {
  /**
   * A stop while it is written would otherwise leave a hidden file in the
   * folder for good; the record lets the next start remove it.
   */
  it('is recorded while it is written, and released once it has its name', async () => {
    await setup('stream');
    fs.writeFileSync(at('From', 'big.bin'), Buffer.alloc(8 * 1024 * 1024, 1));
    const { journalDirectory } = currentEnv.requireFresh('src/services/inFlightFiles');
    const recorded = () =>
      (fs.existsSync(journalDirectory()) ? fs.readdirSync(journalDirectory()) : []).map(
        (name) => JSON.parse(fs.readFileSync(path.join(journalDirectory(), name), 'utf8')).path
      );
    let seenWhileWriting = null;

    const result = await transfer([{ path: 'From', name: 'big.bin' }], 'To', 'copy', {
      onProgress: ({ copiedBytes }) => {
        if (copiedBytes > 0 && seenWhileWriting === null) seenWhileWriting = recorded();
      },
    });

    expect(result.items[0].to).toBe('To/big.bin');
    expect(seenWhileWriting).toHaveLength(1);
    expect(path.dirname(seenWhileWriting[0])).toBe(at('To'));
    expect(path.basename(seenWhileWriting[0])).toMatch(/^\.nextexplorer-copying-/);
    expect(recorded()).toEqual([]);
    expect(names(at('To'))).toEqual(['big.bin']);
  });
});

describe('a move across disks stopped while the source is removed', () => {
  /**
   * The copy is whole by then, and `rm` may already have taken part of the
   * source. Cancelling used to remove the destination as a partial copy, and
   * with it the only whole one.
   */
  it('keeps the whole copy', async () => {
    await setup('native');
    seedAlbum();
    const source = at('From', 'Album');
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (from === source) {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      }
      return rename(from, to);
    });
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

    expect(names(at('To', 'Album'))).toEqual(['mine.txt', 'nested']);
    expect(read(at('To', 'Album', 'nested', 'deep.txt'))).toBe('deep');
  });
});
