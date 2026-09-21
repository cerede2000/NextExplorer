import { afterEach, describe, expect, it } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Forgetting a folder: what the index does when one is excluded from Settings,
 * deleted, or moved out of the volume.
 *
 * It used to go row by row in one go, each delete its own commit, on the only
 * thread the server has. Excluding a large folder froze the application for as
 * long as that took — reported in #11 from an instance indexing a network
 * share, and measured here at two seconds for fifty thousand files on a fast
 * machine. And the folder was found with `LIKE`, which ignores case: `Archive`
 * took `archive` with it.
 */

let envContext;
let db;
let store;

const build = async () => {
  envContext = await setupTestEnv({ tag: 'search-index-forget-' });
  db = await envContext.requireFresh('src/services/indexDb').getIndexDb();
  store = envContext.requireFresh('src/services/searchIndexStore');
};

const put = (path, text) => store.upsertDocument(db, { path, mtimeMs: Date.now(), size: 10, text });

const paths = () =>
  db
    .prepare('SELECT path FROM search_documents ORDER BY path')
    .all()
    .map((row) => row.path);

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('forgetting a folder', () => {
  it('takes the folder and everything under it, and nothing beside it', async () => {
    await build();
    put('Archive', undefined);
    put('Archive/a.txt', 'pangolin');
    put('Archive/sub/b.txt', 'pangolin');
    // Beside it, each sharing something with it.
    put('Archive2/c.txt', 'pangolin');
    put('Archive-old/d.txt', 'pangolin');
    put('Archive.txt', 'pangolin');
    put('Current/Archive/e.txt', 'pangolin');
    // Another folder on a Linux volume, not the same one spelt differently.
    put('archive/f.txt', 'pangolin');

    const removed = await store.removeUnder(db, 'Archive');

    expect(removed).toBe(3);
    expect(paths()).toEqual([
      'Archive-old/d.txt',
      'Archive.txt',
      'Archive2/c.txt',
      'Current/Archive/e.txt',
      'archive/f.txt',
    ]);
    // The words went with the rows: nothing answers from a forgotten file.
    expect(store.search(db, 'pangolin').sort()).toEqual([
      'Archive-old/d.txt',
      'Archive.txt',
      'Archive2/c.txt',
      'Current/Archive/e.txt',
      'archive/f.txt',
    ]);
  });

  it('takes a single file by its own path', async () => {
    await build();
    put('Docs/a.txt', 'pangolin');
    put('Docs/a.txt.bak', 'pangolin');

    expect(await store.removeUnder(db, 'Docs/a.txt')).toBe(1);
    expect(paths()).toEqual(['Docs/a.txt.bak']);
  });

  it('reads the characters of a name literally', async () => {
    await build();
    put('100%_done/x.txt', 'pangolin');
    put('100X_done/y.txt', 'pangolin');

    expect(await store.removeUnder(db, '100%_done')).toBe(1);
    expect(paths()).toEqual(['100X_done/y.txt']);
  });

  it('forgets nothing when given no folder', async () => {
    await build();
    put('Docs/a.txt', 'pangolin');

    expect(await store.removeUnder(db, '')).toBe(0);
    expect(paths()).toEqual(['Docs/a.txt']);
  });
});

describe('the server while a folder is forgotten', () => {
  it('goes on answering between two batches', async () => {
    await build();
    db.transaction(() => {
      for (let index = 0; index < 2500; index += 1) put(`Archive/file-${index}.txt`, 'pangolin');
    })();

    // A turn of the event loop asked for after the removal has started: if
    // it runs before the removal is over, anything else waiting — a listing,
    // a download, another account — would have been answered too.
    let finished = false;
    const removal = Promise.resolve(store.removeUnder(db, 'Archive', { batchSize: 500 })).then(
      (count) => {
        finished = true;
        return count;
      }
    );
    let answeredMeanwhile = null;
    setImmediate(() => {
      answeredMeanwhile = !finished;
    });

    expect(await removal).toBe(2500);
    expect(answeredMeanwhile).toBe(true);
    expect(paths()).toEqual([]);
  });

  it('pauses once between each two batches, and not after the last', async () => {
    await build();
    db.transaction(() => {
      for (let index = 0; index < 2500; index += 1) put(`Archive/file-${index}.txt`, undefined);
    })();
    let pauses = 0;

    const removed = await store.removeUnder(db, 'Archive', {
      batchSize: 1000,
      pause: async () => {
        pauses += 1;
      },
    });

    expect(removed).toBe(2500);
    // 1000, 1000, then 500: the short batch says there is nothing left.
    expect(pauses).toBe(2);
  });
});
