import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The column an installation made before it existed.
 *
 * `trash_items` was created with the trash; `restore_entry` joined its
 * definition a few commits later, when a restore could first be sent into a
 * folder of somebody's choosing. `CREATE TABLE IF NOT EXISTS` adds nothing to a
 * table that is already there, so every installation made in between has a
 * `trash_items` without it — and a restore into a chosen folder writes it, so
 * the first one fails on a column that is not there.
 */

let env;

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'trash-restore-entry-', modules: ['src/services/db'] });
});

afterEach(async () => {
  await env.cleanup();
});

const columns = (db) =>
  db
    .prepare('PRAGMA table_info(trash_items)')
    .all()
    .map((column) => column.name);

describe('a trash table made before restore_entry existed', () => {
  it('gains the column when the database is opened', async () => {
    const dbService = env.requireFresh('src/services/db');
    const db = await dbService.getDb();
    expect(columns(db)).toContain('restore_entry');

    // Put it back the way that installation's table looks: SQLite can drop a
    // column, so the table is rebuilt exactly as it was before it joined.
    db.exec('ALTER TABLE trash_items DROP COLUMN restore_entry');
    expect(columns(db)).not.toContain('restore_entry');
    await dbService.closeDb();

    const reopened = await env.requireFresh('src/services/db').getDb();

    expect(columns(reopened)).toContain('restore_entry');
  });
});
