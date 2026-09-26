import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BetterSqliteSessionStore } from '../../src/utils/betterSqliteSessionStore.js';

/**
 * Where sessions live.
 *
 * They were kept by `connect-sqlite3`, which opens its database when the module
 * is required and leaves every deleted row's pages in the file for ever: a
 * burst of sign-ins — a script, a scanner — grew it and it never shrank again.
 *
 * What this store adds beyond holding them is the ability to answer "whose?":
 * changing a password has to end the sessions opened with the old one, and
 * that is not a thing a key-value store can be asked.
 */

let directory;
let store;

const cookie = { originalMaxAge: null, expires: null, httpOnly: true, path: '/' };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));
  store = new BetterSqliteSessionStore(path.join(directory, 'inner', 'sessions.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const set = (sid, data) => new Promise((resolve) => store.set(sid, data, resolve));
const get = (sid) => new Promise((resolve) => store.get(sid, (_e, sess) => resolve(sess)));

describe('the session store', () => {
  /**
   * Requiring the module must not write to the disk: it happens wherever the
   * cache directory is not there yet, including the check that every module
   * loads.
   */
  it('creates nothing until it is asked for something', () => {
    expect(fs.existsSync(path.join(directory, 'inner'))).toBe(false);

    store.ready();

    expect(fs.existsSync(path.join(directory, 'inner', 'sessions.db'))).toBe(true);
  });

  it('keeps a session and gives it back', async () => {
    await set('one', { cookie, localUserId: 'alice' });

    expect(await get('one')).toMatchObject({ localUserId: 'alice' });
  });

  it('forgets one that has expired', async () => {
    await set('old', { cookie: { ...cookie, expires: new Date(Date.now() - 1000) } });

    expect(await get('old')).toBeUndefined();
  });

  /** What a password change is for: every session opened with the old one. */
  it('ends every session of one account, and leaves the others', async () => {
    await set('a1', { cookie, localUserId: 'alice' });
    await set('a2', { cookie, localUserId: 'alice' });
    await set('b1', { cookie, localUserId: 'bob' });

    store.destroyByUser('alice');

    expect(await get('a1')).toBeUndefined();
    expect(await get('a2')).toBeUndefined();
    expect(await get('b1')).toMatchObject({ localUserId: 'bob' });
  });

  /** The browser doing the changing keeps its own session. */
  it('spares the session it is told to spare', async () => {
    await set('keep', { cookie, localUserId: 'alice' });
    await set('drop', { cookie, localUserId: 'alice' });

    store.destroyByUser('alice', 'keep');

    expect(await get('keep')).toMatchObject({ localUserId: 'alice' });
    expect(await get('drop')).toBeUndefined();
  });

  /**
   * A row that is not JSON must be skipped, not fail the statement: SQLite
   * promises no order for the terms of an AND, so json_extract would raise.
   */
  it('is not stopped by a row that is not JSON', async () => {
    store.ready();
    store.db
      .prepare('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)')
      .run('broken', Date.now() + 60_000, 'not json at all');
    await set('mine', { cookie, localUserId: 'alice' });

    expect(() => store.destroyByUser('alice')).not.toThrow();
    expect(await get('mine')).toBeUndefined();
  });
});
