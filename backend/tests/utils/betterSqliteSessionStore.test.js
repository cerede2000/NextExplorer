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

/**
 * The other half of the same fix.
 *
 * A session the identity provider opened holds its tokens and no account id,
 * so the account it belongs to is the subject of its id token. Ending those
 * too is what stops a password change leaving a signed-in browser behind — and
 * the risk runs the other way as well: a subject is only unique within its
 * issuer, and a row nobody can read must not be ended on a guess.
 */
describe('BetterSqliteSessionStore and the sessions the identity provider opened', () => {
  const ISSUER = 'https://idp.example';

  const idToken = (claims) => {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
  };

  /** A row as express-openid-connect writes it: the token set under `data`. */
  const providerSession = (claims) => ({
    cookie: { maxAge: 60_000 },
    header: { iat: 1, uat: 1, exp: 2 },
    data: { id_token: idToken(claims), access_token: 'opaque' },
  });

  const identity = (subject, issuer = ISSUER) => [{ issuer, subject }];

  const remaining = (store) =>
    store.db
      .prepare('SELECT sid FROM sessions ORDER BY sid')
      .all()
      .map((row) => row.sid);

  it('ends the ones whose id token names the account, and keeps the one named', async () => {
    const store = createStore();
    await callStore(store, 'set', 'alice-laptop', providerSession({ iss: ISSUER, sub: 'alice-1' }));
    await callStore(store, 'set', 'alice-phone', providerSession({ iss: ISSUER, sub: 'alice-1' }));
    await callStore(store, 'set', 'alice-here', providerSession({ iss: ISSUER, sub: 'alice-1' }));

    expect(store.destroyByUser('alice', 'alice-here', identity('alice-1'))).toBe(2);

    expect(remaining(store)).toEqual(['alice-here']);
    store.close();
  });

  /** An account may sign in at more than one provider, or under more than one subject. */
  it('ends the sessions of every identity the account signs in with', async () => {
    const store = createStore();
    await callStore(store, 'set', 'work', providerSession({ iss: ISSUER, sub: 'alice-1' }));
    await callStore(
      store,
      'set',
      'other',
      providerSession({ iss: 'https://other.example', sub: 'a' })
    );

    expect(
      store.destroyByUser('alice', null, [
        { issuer: ISSUER, subject: 'alice-1' },
        { issuer: 'https://other.example', subject: 'a' },
      ])
    ).toBe(2);

    expect(remaining(store)).toEqual([]);
    store.close();
  });

  /**
   * Signing a stranger out would be blamed on anything but a password change,
   * so each of the ways a row can look like this account's without being it is
   * refused on its own.
   */
  it("never ends another account's session", async () => {
    const store = createStore();
    await callStore(store, 'set', 'bob', providerSession({ iss: ISSUER, sub: 'bob-1' }));
    // The same subject at another provider is another person.
    await callStore(
      store,
      'set',
      'elsewhere',
      providerSession({ iss: 'https://other.example', sub: 'alice-1' })
    );
    // An id token that names no issuer cannot be placed, so it matches nothing.
    await callStore(store, 'set', 'issuerless', providerSession({ sub: 'alice-1' }));
    await callStore(store, 'set', 'local-bob', { cookie: { maxAge: 60_000 }, localUserId: 'bob' });
    await callStore(store, 'set', 'anonymous', { cookie: { maxAge: 60_000 } });

    expect(store.destroyByUser('alice', null, identity('alice-1'))).toBe(0);

    expect(remaining(store)).toEqual(['anonymous', 'bob', 'elsewhere', 'issuerless', 'local-bob']);
    store.close();
  });

  /** The two halves are one pass, and it reports what it ended in total. */
  it('ends the sessions signed in here as well', async () => {
    const store = createStore();
    await callStore(store, 'set', 'password', { cookie: { maxAge: 60_000 }, localUserId: 'alice' });
    await callStore(store, 'set', 'provider', providerSession({ iss: ISSUER, sub: 'alice-1' }));

    expect(store.destroyByUser('alice', null, identity('alice-1'))).toBe(2);

    expect(remaining(store)).toEqual([]);
    store.close();
  });

  /**
   * `OIDC_ISSUER` is written by hand and the `iss` claim is minted by the
   * provider; the same provider written with and without its trailing slash is
   * the same provider.
   */
  it('reads the issuer the same way whether or not it ends in a slash', async () => {
    const store = createStore();
    await callStore(store, 'set', 'alice', providerSession({ iss: ISSUER, sub: 'alice-1' }));

    expect(store.destroyByUser('alice', null, identity('alice-1', `${ISSUER}/`))).toBe(1);

    expect(remaining(store)).toEqual([]);
    store.close();
  });

  it('is not stopped by a row it cannot read, and ends the ones after it', () => {
    const store = createStore();
    const insert = store.db.prepare('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)');
    insert.run('not-json', Date.now() + 60_000, '{"data": {"id_token"');
    insert.run(
      'not-a-jwt',
      Date.now() + 60_000,
      JSON.stringify({ data: { id_token: 'nonsense' } })
    );
    insert.run(
      'not-an-object',
      Date.now() + 60_000,
      JSON.stringify({
        data: { id_token: `x.${Buffer.from('"a string"').toString('base64url')}.y` },
      })
    );
    insert.run(
      'not-base64',
      Date.now() + 60_000,
      JSON.stringify({ data: { id_token: 'x.@@@@.y' } })
    );
    insert.run(
      'alice',
      Date.now() + 60_000,
      JSON.stringify(providerSession({ iss: ISSUER, sub: 'alice-1' }))
    );

    expect(store.destroyByUser('alice', null, identity('alice-1'))).toBe(1);

    expect(remaining(store)).toEqual(['not-a-jwt', 'not-an-object', 'not-base64', 'not-json']);
    store.close();
  });

  /** An expired row is still a row somebody's browser holds the cookie for. */
  it('reaches a session that has already expired', () => {
    const store = createStore();
    store.db
      .prepare('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)')
      .run(
        'stale',
        Date.now() - 60_000,
        JSON.stringify(providerSession({ iss: ISSUER, sub: 'alice-1' }))
      );

    expect(store.destroyByUser('alice', null, identity('alice-1'))).toBe(1);

    expect(remaining(store)).toEqual([]);
    store.close();
  });

  it('ends nothing when the account signs in at no provider', async () => {
    const store = createStore();
    await callStore(store, 'set', 'provider', providerSession({ iss: ISSUER, sub: 'alice-1' }));

    expect(store.destroyByUser('alice', null)).toBe(0);
    expect(store.destroyByUser('alice', null, [])).toBe(0);
    expect(store.destroyByUser('alice', null, [{ issuer: ISSUER, subject: null }])).toBe(0);

    expect(remaining(store)).toEqual(['provider']);
    store.close();
  });
});
