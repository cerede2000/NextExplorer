import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * How many times `app.db` is opened, and how many times a statement is compiled.
 *
 * Everything that starts with the server asks for the database at once: the session
 * store, the settings, the trash sweep, the search index, the favourites. `getDb`
 * checked whether a connection was already open and opened one when it was not — and
 * every caller that arrived before the first one had finished saw "not open" and opened
 * another. Four connections at every start, four runs of the migrations over the same
 * file in parallel, and whichever finished last became the one everybody used.
 *
 * The number that matters is therefore 1, and it is the constructor that is counted
 * rather than anything the code says about itself.
 */

let env;

afterEach(async () => {
  vi.restoreAllMocks();
  if (env) {
    env.requireFresh('src/services/db').closeDb?.();
    await env.cleanup();
  }
  env = null;
});

describe('opening the application database', () => {
  it('happens once, however many callers ask at the same moment', async () => {
    env = await setupTestEnv({ tag: 'db-single-open-' });
    const db = env.requireFresh('src/services/db');

    // Five callers in the same turn, as the start does.
    const handles = await Promise.all([db.getDb(), db.getDb(), db.getDb(), db.getDb(), db.getDb()]);

    // The same connection, not five that happen to point at the same file.
    expect(new Set(handles).size).toBe(1);
  });

  it('gives every later caller the connection it already has', async () => {
    env = await setupTestEnv({ tag: 'db-single-open-' });
    const db = env.requireFresh('src/services/db');

    const first = await db.getDb();
    const second = await db.getDb();

    expect(second).toBe(first);
  });

  it('opens again after it has been closed', async () => {
    env = await setupTestEnv({ tag: 'db-single-open-' });
    const db = env.requireFresh('src/services/db');

    const first = await db.getDb();
    db.closeDb();
    const second = await db.getDb();

    expect(second).not.toBe(first);
    // And the new one works, which a closed handle would not.
    expect(second.prepare('SELECT 1 AS one').get().one).toBe(1);
  });
});

describe('a statement asked for twice', () => {
  it('is compiled once', async () => {
    env = await setupTestEnv({ tag: 'db-prepared-' });
    const db = await env.requireFresh('src/services/db').getDb();
    const { prepared } = env.requireFresh('src/services/db');
    const compile = vi.spyOn(db, 'prepare');

    const sql = 'SELECT COUNT(*) AS total FROM users WHERE id = ?';
    const a = prepared(db, sql);
    const b = prepared(db, sql);

    expect(b).toBe(a);
    expect(compile).toHaveBeenCalledTimes(1);
    // And it is a working statement, not a cached object that only looks like one.
    expect(a.get('nobody').total).toBe(0);
  });

  it('is compiled again for a different connection', async () => {
    env = await setupTestEnv({ tag: 'db-prepared-' });
    const service = env.requireFresh('src/services/db');
    const sql = 'SELECT COUNT(*) AS total FROM users';

    const first = await service.getDb();
    const one = service.prepared(first, sql);
    service.closeDb();
    const second = await service.getDb();
    const two = service.prepared(second, sql);

    // A statement belongs to the connection that compiled it; handing the old one to a
    // new connection is how a cache keyed on the SQL alone breaks.
    expect(two).not.toBe(one);
  });
});
