import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Finding a file by its name, from the catalogue rather than by walking.
 *
 * A name search that reads the storage is a name search that does not finish
 * on a network share, so names are kept in the index beside the words — a row
 * per file, whether or not it has any text in it, since a photograph has a
 * name and no words.
 *
 * Two things about how the rows are found are worth pinning, because both were
 * wrong in ways nobody would guess from the results: the fold, and the bounds.
 */

let envContext;
let db;
let store;

const volumePath = (...parts) => path.join(envContext.volumeDir, ...parts);

beforeEach(async () => {
  envContext = await setupTestEnv({
    tag: 'search-catalogue-',
    env: { SEARCH_INDEX: 'true', SEARCH_INDEX_CPU_PERCENT: '100' },
  });
  db = await envContext.requireFresh('src/services/indexDb').getIndexDb();
  store = envContext.requireFresh('src/services/searchIndexStore');
});

afterEach(async () => {
  envContext.requireFresh('src/services/indexDb').closeIndexDb();
  await envContext.cleanup();
});

const index = async (relative, text = '') => {
  const absolute = volumePath(...relative.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, text);
  const stats = await fs.stat(absolute);
  store.upsertDocument(db, {
    path: relative,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    text,
  });
};

const indexFolder = async (relative) => {
  await fs.mkdir(volumePath(...relative.split('/')), { recursive: true });
  store.upsertDocument(db, { path: relative, mtimeMs: 0, size: 0, isDirectory: true });
};

// The iterator plucks the path, so each row is the path itself.
const namesFound = (literal, options = {}) => [
  ...store.iterateNameCandidates(db, { base: '', literal, ...options }),
];

describe('the catalogue of names', () => {
  it('holds a file that has no words in it at all', async () => {
    await index('Photos/sunset.jpg');

    expect(namesFound('sunset')).toEqual(['Photos/sunset.jpg']);
  });

  it('finds a name whatever case it was typed in', async () => {
    await index('Docs/Rapport.txt', 'le mot pangolin');

    expect(namesFound('rapport')).toEqual(['Docs/Rapport.txt']);
  });

  /**
   * What the fold is actually for. SQLite's LIKE only folds the twenty-six
   * letters of ASCII, so `É` and `é` are two different characters to it — and
   * a name is composed as well, because a French keyboard and a Mac write the
   * same accented letter in two different sequences of code points.
   */
  it('finds an accented name typed in the other case', async () => {
    await index('Docs/Éléments.txt');

    expect(namesFound('éléments')).toEqual(['Docs/Éléments.txt']);
  });

  it('finds a name whose accent was typed as two code points', async () => {
    // 'e' followed by a combining acute, as a Mac writes it. The row is stored
    // under the path as it is on the disk; what is folded is the name it is
    // looked up by.
    const decomposed = `Docs/${'Éléments.txt'.normalize('NFD')}`;
    await index(decomposed);

    const found = namesFound('éléments'.normalize('NFC'));

    expect(found).toHaveLength(1);
    expect(found[0].normalize('NFC')).toBe('Docs/Éléments.txt'.normalize('NFC'));
  });

  it('finds a name in the middle of one', async () => {
    await index('Docs/quarterly-rapport-final.txt');

    expect(namesFound('rapport')).toEqual(['Docs/quarterly-rapport-final.txt']);
  });

  it('has a row of its own for a folder, so an empty one can be found', async () => {
    await indexFolder('Projects/Archive');

    expect(namesFound('archive', { folders: true })).toEqual(['Projects/Archive']);
    // And it is not offered as a file.
    expect(namesFound('archive')).toEqual([]);
  });
});

describe('what a folder is asked about', () => {
  /**
   * `LIKE 'Docs/%'` ignores case, so `docs/` and `Docs/` were one folder — on
   * a case-sensitive filesystem they are two, and a search inside one answered
   * with the other's files.
   */
  it('keeps two folders whose names differ only in case apart', async () => {
    // Inside a subfolder, so it is the bound on the range that has to answer
    // and not the equality beside it.
    await index('Docs/deeper/one.txt', 'pangolin');
    await index('docs/deeper/two.txt', 'pangolin');

    const inUpper = [...store.iterateNameCandidates(db, { base: 'Docs', literal: '' })];

    expect(inUpper).toEqual(['Docs/deeper/one.txt']);
  });

  /** A folder called `100%_done` is a pattern to LIKE, and matched its siblings. */
  it('is not confused by a folder whose name is a wildcard', async () => {
    await index('100%_done/deeper/one.txt', 'pangolin');
    await index('1000_done/deeper/two.txt', 'pangolin');

    const inside = [...store.iterateNameCandidates(db, { base: '100%_done', literal: '' })];

    expect(inside).toEqual(['100%_done/deeper/one.txt']);
  });
});

describe('forgetting a folder', () => {
  /**
   * An administrator excluding a folder means it stops being searchable now,
   * not at the next pass — until then the index goes on answering from a
   * folder somebody said not to read.
   */
  it('takes away everything under it', async () => {
    await index('Private/secret.txt', 'pangolin');
    await index('Private/deeper/also.txt', 'pangolin');
    await index('Public/open.txt', 'pangolin');

    const removed = await store.removeUnder(db, 'Private');

    expect(removed).toBe(2);
    expect(namesFound('')).toEqual(['Public/open.txt']);
  });

  it('leaves a folder whose name merely starts the same way', async () => {
    await index('Private/secret.txt', 'pangolin');
    await index('PrivateMirror/open.txt', 'pangolin');

    await store.removeUnder(db, 'Private');

    expect(namesFound('')).toEqual(['PrivateMirror/open.txt']);
  });
});
