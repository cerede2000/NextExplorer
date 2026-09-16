import { describe, it, expect, afterEach } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What a password change leaves signed in.
 *
 * Changing a password is what someone does when they think it leaked, and the
 * promise made in the administrator's guide is that it signs the account out
 * everywhere but where the change was made. Sessions opened by signing in here
 * carry the account id and were already ended; the ones the identity provider
 * opened carry its tokens instead, and stayed open for as long as they lasted —
 * thirty days by default — with whoever had the password still inside.
 *
 * This is the whole chain: the account's provider identities are read from
 * `auth_methods`, the id token of each session is read back, and the two are
 * matched. The store is exercised on its own in tests/utils; here it is the
 * joining up that is at stake, because that is what nobody had done.
 */

const ISSUER = 'https://idp.example';

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const idToken = (claims) => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
};

/** A row as express-openid-connect writes it: the token set under `data`. */
const providerSession = (sub, issuer = ISSUER) => ({
  cookie: { maxAge: 60_000 },
  header: { iat: 1, uat: 1, exp: 2 },
  data: { id_token: idToken({ iss: issuer, sub }), access_token: 'opaque' },
});

const build = async () => {
  envContext = await setupTestEnv({ tag: 'password-change-sessions-' });
  // Before the service: it loads the store lazily, and both must end up with
  // the same sessions.db.
  const { localStore } = envContext.requireFresh('src/utils/sessionStore');
  const users = envContext.requireFresh('src/services/users');
  const db = await envContext.requireFresh('src/services/db').getDb();
  return { users, db, localStore };
};

const linkProviderIdentity = (db, userId, sub, issuer = ISSUER) => {
  db.prepare(
    `INSERT INTO auth_methods (id, user_id, method_type, provider_issuer, provider_sub, provider_name, created_at)
     VALUES (?, ?, 'oidc', ?, ?, 'OIDC', ?)`
  ).run(`auth-${sub}`, userId, issuer, sub, new Date().toISOString());
};

const openSessions = (localStore) =>
  localStore.db
    .prepare('SELECT sid FROM sessions ORDER BY sid')
    .all()
    .map((row) => row.sid);

describe('changing a password', () => {
  it('ends the sessions the identity provider opened for that account, and no others', async () => {
    const { users, db, localStore } = await build();
    const alice = await users.createLocalUser({
      email: 'alice@example.com',
      password: 'secret123',
      username: 'alice',
      displayName: 'Alice',
    });
    const bob = await users.createLocalUser({
      email: 'bob@example.com',
      password: 'secret123',
      username: 'bob',
      displayName: 'Bob',
    });
    linkProviderIdentity(db, alice.id, 'alice-1');
    linkProviderIdentity(db, bob.id, 'bob-1');
    localStore.set('alice-sso', providerSession('alice-1'));
    localStore.set('alice-here', providerSession('alice-1'));
    localStore.set('alice-password', { cookie: { maxAge: 60_000 }, localUserId: alice.id });
    localStore.set('bob-sso', providerSession('bob-1'));

    await users.changeLocalPassword({
      userId: alice.id,
      currentPassword: 'secret123',
      newPassword: 'newpass456',
      keepSessionId: 'alice-here',
    });

    expect(openSessions(localStore)).toEqual(['alice-here', 'bob-sso']);
  }, 30_000);

  /**
   * The administrator's reset makes the same promise, from the other side: the
   * person whose password was reset is signed out everywhere.
   */
  it('ends them when an administrator resets the password too', async () => {
    const { users, db, localStore } = await build();
    const alice = await users.createLocalUser({
      email: 'alice@example.com',
      password: 'secret123',
      username: 'alice',
      displayName: 'Alice',
    });
    linkProviderIdentity(db, alice.id, 'alice-1');
    localStore.set('alice-sso', providerSession('alice-1'));

    await users.setLocalPasswordAdmin({ userId: alice.id, newPassword: 'newpass456' });

    expect(openSessions(localStore)).toEqual([]);
  }, 30_000);

  /**
   * Giving a password to an account that had none ends nothing: no session was
   * opened with it, and the person is in the middle of using one of them.
   */
  it('leaves the provider sessions alone when the account is given its first password', async () => {
    const { users, db, localStore } = await build();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES ('user-sso', 'sso@example.com', 1, 'sso', 'Sso', '["user"]', ?, ?)`
    ).run(now, now);
    linkProviderIdentity(db, 'user-sso', 'sso-1');
    localStore.set('sso-open', providerSession('sso-1'));

    await users.setLocalPasswordAdmin({ userId: 'user-sso', newPassword: 'newpass456' });

    expect(openSessions(localStore)).toEqual(['sso-open']);
  }, 30_000);
});
