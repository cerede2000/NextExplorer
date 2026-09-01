import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { buildPdf } from '../helpers/pdf-fixture.js';

/**
 * The index keeps terms, not text, and is built by a walk that has to be
 * interruptible: one that cannot be stopped decides for itself when the server
 * is free, and it is always wrong about that.
 */

let envContext;
let db;
let store;
let indexer;

const volumePath = (...parts) => path.join(envContext.volumeDir, ...parts);

const build = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'search-index-', env });
  const dbService = envContext.requireFresh('src/services/db');
  db = await dbService.getDb();
  store = envContext.requireFresh('src/services/searchIndexStore');
  indexer = envContext.requireFresh('src/services/searchIndexer');
};

const indexAll = (options = {}) =>
  indexer.indexTree({ db, rootAbs: envContext.volumeDir, pauseMs: 0, ...options });

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('what the index knows', () => {
  beforeEach(async () => {
    await build();
    await fs.mkdir(volumePath('Docs'), { recursive: true });
    await fs.writeFile(
      volumePath('Docs', 'notes.md'),
      '# Notes\n\nle pangolin mange des fourmis\n'
    );
    await fs.writeFile(volumePath('Docs', 'other.txt'), 'rien de particulier ici\n');
  });

  it('finds a document by a word inside it', async () => {
    await indexAll();

    expect(store.search(db, 'pangolin')).toEqual(['Docs/notes.md']);
  });

  // The schema asks for it, and it is what makes a French index usable.
  it('ignores accents and case', async () => {
    await indexAll();

    expect(store.search(db, 'FOURMIS')).toEqual(['Docs/notes.md']);
    expect(store.search(db, 'pangolín')).toEqual(['Docs/notes.md']);
  });

  it('says nothing for a word nobody wrote', async () => {
    await indexAll();

    expect(store.search(db, 'tatou')).toEqual([]);
  });

  it('reads Office documents and PDFs too', async () => {
    await fs.writeFile(volumePath('Docs', 'report.pdf'), buildPdf('the pangolin report'));
    await indexAll();

    expect(store.search(db, 'report')).toContain('Docs/report.pdf');
  });

  // A term the user typed is a term, not an expression: someone searching for
  // `NOT` or a quote is looking for those characters.
  it('takes a query that would otherwise be FTS syntax', async () => {
    await fs.writeFile(volumePath('Docs', 'odd.txt'), 'the word NOT appears here\n');
    await indexAll();

    expect(store.search(db, 'NOT')).toContain('Docs/odd.txt');
    expect(() => store.search(db, '"')).not.toThrow();
  });
});

describe('keeping up with the files', () => {
  beforeEach(async () => {
    await build();
    await fs.mkdir(volumePath('Docs'), { recursive: true });
    await fs.writeFile(volumePath('Docs', 'notes.md'), 'le pangolin est là\n');
  });

  // The second run is what has to be cheap, or an index is a tax.
  it('does not open a file it has already read', async () => {
    const first = await indexAll();
    expect(first.indexed).toBe(1);

    const second = await indexAll();
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('notices a file that changed', async () => {
    await indexAll();
    await fs.writeFile(volumePath('Docs', 'notes.md'), 'le tatou a pris sa place\n');

    const again = await indexAll();

    expect(again.indexed).toBe(1);
    expect(store.search(db, 'pangolin')).toEqual([]);
    expect(store.search(db, 'tatou')).toEqual(['Docs/notes.md']);
  });

  it('forgets a file that is gone', async () => {
    await indexAll();
    await fs.rm(volumePath('Docs', 'notes.md'));

    const again = await indexAll();

    expect(again.removed).toBe(1);
    expect(store.search(db, 'pangolin')).toEqual([]);
  });

  it('follows a rename without reading anything again', async () => {
    await indexAll();

    store.movePath(db, 'Docs', 'Archive');

    expect(store.search(db, 'pangolin')).toEqual(['Archive/notes.md']);
  });
});

describe('being interruptible', () => {
  beforeEach(async () => {
    await build();
    await fs.mkdir(volumePath('Docs'), { recursive: true });
    for (let index = 0; index < 60; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await fs.writeFile(volumePath('Docs', `file-${index}.txt`), `document ${index} pangolin\n`);
    }
  });

  it('stops when asked and says so', async () => {
    const controller = new AbortController();
    const running = indexAll({ signal: controller.signal, batchSize: 5, pauseMs: 5 });
    // Long enough to have started, far short of sixty files.
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();

    const result = await running;

    expect(result.interrupted).toBe(true);
    expect(result.indexed).toBeLessThan(60);
  });

  // What it did get through is kept: the next run has that much less to do.
  it('keeps the work it had already done', async () => {
    const controller = new AbortController();
    const running = indexAll({ signal: controller.signal, batchSize: 5, pauseMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const first = await running;

    expect(store.stats(db).documents).toBe(first.indexed);

    const second = await indexAll();
    expect(second.skipped).toBe(first.indexed);
    expect(store.stats(db).documents).toBe(60);
  });

  // An interrupted walk has not seen the whole tree, so it cannot know what is
  // missing from it — deleting on that basis would empty the index.
  it('does not decide what is missing when it was cut short', async () => {
    await indexAll();
    expect(store.stats(db).documents).toBe(60);

    const controller = new AbortController();
    controller.abort();
    const result = await indexAll({ signal: controller.signal });

    expect(result.interrupted).toBe(true);
    expect(result.removed).toBe(0);
    expect(store.stats(db).documents).toBe(60);
  });
});

describe('what it leaves out', () => {
  beforeEach(async () => {
    await build({ SEARCH_MAX_FILESIZE: '2K' });
    await fs.mkdir(volumePath('Docs'), { recursive: true });
  });

  it('leaves a file bigger than the limit alone', async () => {
    await fs.writeFile(volumePath('Docs', 'big.txt'), `${'x'.repeat(4096)}\npangolin\n`);
    await fs.writeFile(volumePath('Docs', 'small.txt'), 'pangolin\n');

    await indexAll();

    expect(store.search(db, 'pangolin')).toEqual(['Docs/small.txt']);
  });

  // A null byte is the giveaway, and it has to be the one that decides: the
  // rest of this file is perfectly ordinary text, which is what a real binary
  // with embedded strings looks like.
  it('leaves binaries alone', async () => {
    await fs.writeFile(
      volumePath('Docs', 'blob.bin'),
      Buffer.from(
        'pangolin\u0000pangolin\u0000pangolin and a great deal of ordinary text',
        'binary'
      )
    );
    await fs.writeFile(volumePath('Docs', 'text.txt'), 'pangolin\n');

    await indexAll();

    expect(store.search(db, 'pangolin')).toEqual(['Docs/text.txt']);
    expect(store.stats(db).documents).toBe(1);
  });
});
