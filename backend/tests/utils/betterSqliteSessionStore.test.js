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
