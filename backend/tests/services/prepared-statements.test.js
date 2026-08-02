import { describe, it, expect, afterEach, vi } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * better-sqlite3 compiles the SQL on every prepare() call. Services that run
 * once per item were recompiling the same statements thousands of times: a CPU
 * profile of a 3000-file delete put prepare() at the top of the applied work,
 * ahead of the filesystem calls it exists to support.
 */

let currentEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

describe('Prepared statement cache', () => {
  it('compiles a given statement once per database handle', async () => {
    const env = await setupTestEnv({
      tag: 'prepared-cache-',
      modules: ['src/config/env', 'src/config/index', 'src/services/db'],
    });
    currentEnv = env;

    const { getDb, prepared } = env.requireFresh('src/services/db');
    const db = await getDb();
    const spy = vi.spyOn(db, 'prepare');

    const sql = 'SELECT * FROM shares WHERE source_space = ? AND source_path = ?';
    const first = prepared(db, sql);
    for (let i = 0; i < 500; i += 1) prepared(db, sql);

    expect(spy).toHaveBeenCalledTimes(1);
    // And it is the same statement, not a lookalike.
    expect(prepared(db, sql)).toBe(first);
  });

  it('keeps different statements apart', async () => {
    const env = await setupTestEnv({
      tag: 'prepared-cache-distinct-',
      modules: ['src/config/env', 'src/config/index', 'src/services/db'],
    });
    currentEnv = env;

    const { getDb, prepared } = env.requireFresh('src/services/db');
    const db = await getDb();

    const a = prepared(db, 'SELECT * FROM shares WHERE id = ?');
    const b = prepared(db, 'SELECT * FROM shares WHERE owner_id = ?');

    expect(a).not.toBe(b);
  });
});
