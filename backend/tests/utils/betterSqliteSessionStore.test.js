import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { BetterSqliteSessionStore } = require('../../src/utils/betterSqliteSessionStore');

const temporaryDirectories = [];

const createStore = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nextexplorer-session-store-'));
  temporaryDirectories.push(directory);
  return new BetterSqliteSessionStore(path.join(directory, 'sessions.db'));
};

const callStore = (store, method, ...args) =>
  new Promise((resolve, reject) => {
    store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('BetterSqliteSessionStore', () => {
  it('persists sessions using the existing connect-sqlite3 table layout', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nextexplorer-session-store-'));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, 'sessions.db');
    const legacyDb = new Database(filename);
    legacyDb.exec('CREATE TABLE sessions (sid PRIMARY KEY, expired, sess)');
    legacyDb
      .prepare('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)')
      .run(
        'legacy-session',
        Date.now() + 60_000,
        JSON.stringify({ user: { sub: 'existing-user' } })
      );
    legacyDb.close();

    const store = new BetterSqliteSessionStore(filename);
    await expect(callStore(store, 'get', 'legacy-session')).resolves.toEqual({
      user: { sub: 'existing-user' },
    });
    store.close();
  });

  it('stores, touches and destroys active sessions', async () => {
    const store = createStore();
    const session = { cookie: { maxAge: 60_000 }, user: { sub: 'user-1' } };

    await callStore(store, 'set', 'session-1', session);
    await expect(callStore(store, 'get', 'session-1')).resolves.toEqual(session);
    await expect(callStore(store, 'length')).resolves.toBe(1);

    await callStore(store, 'touch', 'session-1', { cookie: { maxAge: 120_000 } });
    await callStore(store, 'destroy', 'session-1');
    await expect(callStore(store, 'get', 'session-1')).resolves.toBeUndefined();
    store.close();
  });

  it('does not return expired sessions and removes them during cleanup', async () => {
    const store = createStore();
    await callStore(store, 'set', 'expired-session', {
      cookie: { expires: new Date(Date.now() - 1_000).toISOString() },
    });

    await expect(callStore(store, 'get', 'expired-session')).resolves.toBeUndefined();
    store.cleanupExpiredSessions();
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count).toBe(0);
    store.close();
  });
});

/**
 * A password change ends the account's other sessions through this method, so
 * what it matches is the whole of the fix: too little and a session opened
 * with the leaked password survives, too much and somebody else is signed out.
 */
describe('BetterSqliteSessionStore.destroyByUser', () => {
  const signedIn = (userId) => ({ cookie: { maxAge: 60_000 }, localUserId: userId });

  const remaining = (store) =>
    store.db
      .prepare('SELECT sid FROM sessions ORDER BY sid')
      .all()
      .map((row) => row.sid);

  it("ends every session of the account but the one kept, and nobody else's", async () => {
    const store = createStore();
    await callStore(store, 'set', 'alice-laptop', signedIn('alice'));
    await callStore(store, 'set', 'alice-phone', signedIn('alice'));
    await callStore(store, 'set', 'alice-stolen', signedIn('alice'));
    await callStore(store, 'set', 'bob-laptop', signedIn('bob'));
    // Opened by the identity provider: its tokens, and no account id.
    await callStore(store, 'set', 'provider', {
      cookie: { maxAge: 60_000 },
      header: { iat: 1, uat: 1, exp: 2 },
      data: { id_token: 'a.b.c' },
    });
    // A visitor who has not signed in yet.
    await callStore(store, 'set', 'anonymous', { cookie: { maxAge: 60_000 } });

    expect(store.destroyByUser('alice', 'alice-laptop')).toBe(2);

    expect(remaining(store)).toEqual(['alice-laptop', 'anonymous', 'bob-laptop', 'provider']);
    await expect(callStore(store, 'get', 'alice-laptop')).resolves.toEqual(signedIn('alice'));
    store.close();
  });

  /** `sid <> NULL` is never true in SQL, so a missing exception would end nothing. */
  it('ends all of them when none is to be kept', async () => {
    const store = createStore();
    await callStore(store, 'set', 'alice-laptop', signedIn('alice'));
    await callStore(store, 'set', 'alice-phone', signedIn('alice'));
    await callStore(store, 'set', 'bob-laptop', signedIn('bob'));

    expect(store.destroyByUser('alice')).toBe(2);

    expect(remaining(store)).toEqual(['bob-laptop']);
    store.close();
  });

  it('is not stopped by a row that is not JSON, and reaches one already expired', () => {
    const store = createStore();
    const insert = store.db.prepare('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)');
    insert.run('broken', Date.now() + 60_000, '{"localUserId": "alice"');
    insert.run('expired', Date.now() - 60_000, JSON.stringify(signedIn('alice')));
    insert.run('live', Date.now() + 60_000, JSON.stringify(signedIn('alice')));

    expect(store.destroyByUser('alice', null)).toBe(2);

    expect(remaining(store)).toEqual(['broken']);
    store.close();
  });

  it('ends nothing when no account is named', async () => {
    const store = createStore();
    await callStore(store, 'set', 'anonymous', { cookie: { maxAge: 60_000 } });
    await callStore(store, 'set', 'alice-laptop', signedIn('alice'));

    expect(store.destroyByUser(undefined)).toBe(0);
    expect(store.destroyByUser('')).toBe(0);

    expect(remaining(store)).toEqual(['alice-laptop', 'anonymous']);
    store.close();
  });
});
