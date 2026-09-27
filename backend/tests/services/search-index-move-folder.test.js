import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Following a folder the application moved or renamed.
 *
 * Its rows were found with `LIKE`, which ignores case: moving `Docs` carried
 * `docs/…` along, another folder on a Linux volume, listed afterwards under a
 * path that does not exist. And the parent written for each row ended in a
 * slash, which no parent does: a search from the moved folder missed the files
 * directly in it, and the next pass took `Papers/` for a folder that was gone,
 * forgot every row of it, and read the whole folder again on the pass after.
 */

let envContext;
let db;
let store;

const build = async () => {
  envContext = await setupTestEnv({ tag: 'search-index-move-' });
  db = await envContext.requireFresh('src/services/indexDb').getIndexDb();
  store = envContext.requireFresh('src/services/searchIndexStore');
};

const put = (relativePath, text, isDirectory = false) =>
  store.upsertDocument(db, {
    path: relativePath,
    mtimeMs: Date.now(),
    size: 10,
    text,
    isDirectory,
  });

const rows = () =>
  db.prepare('SELECT path, dir, name_fold AS name FROM search_documents ORDER BY path').all();

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('moving a folder', () => {
  it('takes the folder and everything under it, and nothing beside it', async () => {
    await build();
    put('Docs', undefined, true);
    put('Docs/a.txt', 'pangolin');
    put('Docs/sub', undefined, true);
    put('Docs/sub/b.txt', 'pangolin');
    // Beside it, each sharing something with it.
    put('Docs2/c.txt', 'pangolin');
    put('Docs.txt', 'pangolin');
    put('Other/Docs/e.txt', 'pangolin');
    // Another folder on a Linux volume, not the same one spelt differently.
    put('docs/d.txt', 'pangolin');

    expect(store.movePath(db, 'Docs', 'Papers')).toBe(4);

    expect(rows().map((row) => row.path)).toEqual([
      'Docs.txt',
      'Docs2/c.txt',
      'Other/Docs/e.txt',
      'Papers',
      'Papers/a.txt',
      'Papers/sub',
      'Papers/sub/b.txt',
      'docs/d.txt',
    ]);
    // The words moved with the rows.
    expect(store.search(db, 'pangolin').sort()).toEqual([
      'Docs.txt',
      'Docs2/c.txt',
      'Other/Docs/e.txt',
      'Papers/a.txt',
      'Papers/sub/b.txt',
      'docs/d.txt',
    ]);
  });

  it('gives each row the parent it now has, and the folder its new name', async () => {
    await build();
    put('Docs', undefined, true);
    put('Docs/a.txt', 'pangolin');
    put('Docs/sub', undefined, true);
    put('Docs/sub/deep/b.txt', 'pangolin');

    store.movePath(db, 'Docs', 'Archive/2026/Papers');

    expect(rows()).toEqual([
      { path: 'Archive/2026/Papers', dir: 'Archive/2026', name: 'papers' },
      { path: 'Archive/2026/Papers/a.txt', dir: 'Archive/2026/Papers', name: 'a.txt' },
      { path: 'Archive/2026/Papers/sub', dir: 'Archive/2026/Papers', name: 'sub' },
      {
        path: 'Archive/2026/Papers/sub/deep/b.txt',
        dir: 'Archive/2026/Papers/sub/deep',
        name: 'b.txt',
      },
    ]);
  });

  it('moves a single file by its own path', async () => {
    await build();
    put('Docs/a.txt', 'pangolin');
    put('Docs/a.txt.bak', 'pangolin');

    expect(store.movePath(db, 'Docs/a.txt', 'Docs/b.txt')).toBe(1);
    expect(rows()).toEqual([
      { path: 'Docs/a.txt.bak', dir: 'Docs', name: 'a.txt.bak' },
      { path: 'Docs/b.txt', dir: 'Docs', name: 'b.txt' },
    ]);
  });

  it('is found from the folder it moved to', async () => {
    await build();
    put('Docs', undefined, true);
    put('Docs/a.txt', 'pangolin');

    store.movePath(db, 'Docs', 'Papers');

    // By name and by contents, asked from inside the folder, as a search
    // started there asks.
    expect([...store.iterateNameCandidates(db, { base: 'Papers', literal: 'a.txt' })]).toEqual([
      'Papers/a.txt',
    ]);
    expect(
      store.searchRanked(db, 'pangolin', 10, { base: 'Papers' }).map((row) => row.path)
    ).toEqual(['Papers/a.txt']);
  });
});

describe('the pass after a move', () => {
  it('neither forgets what moved nor reads it again', async () => {
    await build();
    const volume = envContext.volumeDir;
    await fs.mkdir(path.join(volume, 'Docs', 'sub'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Docs', 'a.txt'), 'le pangolin\n');
    await fs.writeFile(path.join(volume, 'Docs', 'sub', 'b.txt'), 'un autre pangolin\n');
    const { indexTree } = envContext.requireFresh('src/services/searchIndexer');
    await indexTree({ db, rootAbs: volume, cpuPercent: 100 });

    // What the application does on a rename: the disk, then the index.
    await fs.rename(path.join(volume, 'Docs'), path.join(volume, 'Papers'));
    store.movePath(db, 'Docs', 'Papers');
    const pass = await indexTree({ db, rootAbs: volume, cpuPercent: 100 });

    expect(pass.removed).toBe(0);
    expect(pass.indexed).toBe(0);
    expect(store.search(db, 'pangolin').sort()).toEqual(['Papers/a.txt', 'Papers/sub/b.txt']);
  });
});

describe('an index a move had already written wrongly', () => {
  it('has its folders put right when it is opened, once', async () => {
    await build();
    // Opening it has already looked, and says so.
    expect(
      db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .pluck()
        .get('search_index_moved_dirs_repaired')
    ).toBe('1');

    put('Papers/a.txt', 'pangolin');
    put('Papers/sub/b.txt', 'pangolin');
    // What the old move left behind.
    db.prepare("UPDATE search_documents SET dir = dir || '/'").run();
    db.prepare('DELETE FROM meta WHERE key = ?').run('search_index_moved_dirs_repaired');

    expect(store.repairMovedDirs(db)).toBe(2);
    expect(rows().map((row) => row.dir)).toEqual(['Papers', 'Papers/sub']);

    // Not again: nothing writes such a parent any more, and looking is a scan
    // of the whole table.
    db.prepare("UPDATE search_documents SET dir = dir || '/'").run();
    expect(store.repairMovedDirs(db)).toBe(0);
  });
});
