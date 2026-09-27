import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The indexes belong to a database of their own, under the cache directory.
 *
 * The numbered migrations still create their tables in app.db — an installation
 * from before the split has them there, with rows in them — so opening app.db
 * carries them over once and drops them. `folder_size_index` used to be
 * re-created here on every open as well, which put it straight back after the
 * carry-over had taken it out: app.db kept a table nothing read while the indexer
 * read the one in the cache, and an installation upgrading re-walked its whole
 * volume to fill an index it already had.
 */

const INDEX_TABLES = ['search_terms', 'search_documents', 'folder_size_index'];

let env;

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'index-out-of-app-', modules: ['src/services/db'] });
});

afterEach(async () => {
  await env.cleanup();
});

const tablesIn = (db) =>
  new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());

describe('app.db and the indexes', () => {
  it('does not keep them, on the open that creates it or on the next one', async () => {
    const dbService = env.requireFresh('src/services/db');
    const db = await dbService.getDb();

    const present = INDEX_TABLES.filter((name) => tablesIn(db).has(name));
    expect(present).toEqual([]);

    await dbService.closeDb();
    const reopened = await env.requireFresh('src/services/db').getDb();

    expect(INDEX_TABLES.filter((name) => tablesIn(reopened).has(name))).toEqual([]);
  });

  it('carries over what an older app.db was holding, and then drops it', async () => {
    const dbService = env.requireFresh('src/services/db');
    const db = await dbService.getDb();

    // Put app.db back the way an installation from before the split looks: the
    // table is there, and it has a row somebody's folder size is in.
    db.exec(dbService.FOLDER_SIZE_INDEX_DDL);
    expect(tablesIn(db).has('folder_size_index')).toBe(true);
    await dbService.closeDb();

    const reopened = await env.requireFresh('src/services/db').getDb();

    expect(tablesIn(reopened).has('folder_size_index')).toBe(false);
  });
});
