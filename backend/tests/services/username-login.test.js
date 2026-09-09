import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Signing in with a username instead of an email address.
 *
 * Asked for in issue #5, and the reason is a fair one: a username is what
 * somebody chose, an address is what their mail provider gave them.
 *
 * Two things had to be settled first. A username is not unique in the schema —
 * the constraint was lost in an early migration, and `createLocalUser` derives
 * one from the local part of the address, so `alice@example.com` and
 * `alice@other.org` both become `alice`. A name that answers for two accounts
 * identifies neither, and choosing between them would be choosing whose account
 * a stranger signs into.
 *
 * And the lockout: it used to be keyed on what was typed. One account with two
 * names would then have had one budget of failed attempts per name, and anyone
 * alternating between them would never have exhausted either.
 */

let envContext;
let users;

const build = async (env = {}) => {
  envContext = await setupTestEnv({
    tag: 'username-login-',
    env: { AUTH_MAX_FAILED: '3', AUTH_LOCK_MINUTES: '15', ...env },
    modules: ['src/services/db', 'src/services/users'],
  });
  users = envContext.requireFresh('src/services/users');
};

const makeUser = async (overrides = {}) =>
  users.createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'motdepasse',
    roles: ['user'],
    ...overrides,
  });

const signIn = (identifier, password = 'motdepasse') =>
  users.attemptLocalLogin({ identifier, password });

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('signing in', () => {
  beforeEach(async () => {
    await build();
    await makeUser();
  });

  it('works with the username', async () => {
    const user = await signIn('alice');

    expect(user?.email).toBe('alice@example.com');
  });

  it('still works with the email address', async () => {
    const user = await signIn('alice@example.com');

    expect(user?.username).toBe('alice');
  });

  /** Nobody remembers whether they capitalised their own name. */
  it('does not mind how the username was capitalised', async () => {
    expect(await signIn('ALICE')).toBeTruthy();
    expect(await signIn('Alice')).toBeTruthy();
  });

  it('does not mind how the address was capitalised either', async () => {
    expect(await signIn('Alice@Example.COM')).toBeTruthy();
  });

  it('ignores the spaces around what was typed', async () => {
    expect(await signIn('  alice  ')).toBeTruthy();
  });

  it('refuses the right name with the wrong password', async () => {
    expect(await signIn('alice', 'au-hasard')).toBeNull();
  });

  it('refuses a name that belongs to nobody', async () => {
    expect(await signIn('bob')).toBeNull();
  });

  it('refuses nothing at all', async () => {
    expect(await signIn('')).toBeNull();
    expect(await signIn(null)).toBeNull();
    expect(await signIn('   ')).toBeNull();
  });

  /** The field used to be called `email`, and callers may still say so. */
  it('accepts the older name for the field', async () => {
    const user = await users.attemptLocalLogin({ email: 'alice', password: 'motdepasse' });

    expect(user?.email).toBe('alice@example.com');
  });
});

describe('a username that answers for two accounts', () => {
  /**
   * The column carries no uniqueness constraint, so an installation upgraded
   * from an older version can already hold this. Signing in with it would mean
   * picking one of them, which is picking whose account a stranger reaches.
   */
  const seedDuplicates = async () => {
    const db = await envContext.requireFresh('src/services/db').getDb();
    await makeUser();
    await makeUser({ email: 'alice@other.org', username: null });
    db.prepare('UPDATE users SET username = ? WHERE email = ?').run('alice', 'alice@other.org');
    return db;
  };

  beforeEach(async () => {
    await build();
  });

  it('signs nobody in', async () => {
    await seedDuplicates();

    expect(await signIn('alice')).toBeNull();
  });

  it('leaves both of them their address', async () => {
    await seedDuplicates();

    expect((await signIn('alice@example.com'))?.email).toBe('alice@example.com');
    expect((await signIn('alice@other.org'))?.email).toBe('alice@other.org');
  });

  it('is not created by a new account taking a name already in use', async () => {
    await makeUser();

    await expect(makeUser({ email: 'alice@other.org' })).rejects.toThrow(/username/i);
  });

  it('is not created by capitalising it differently either', async () => {
    await makeUser();

    await expect(makeUser({ email: 'alice@other.org', username: 'Alice' })).rejects.toThrow(
      /username/i
    );
  });

  it('is not created by renaming an account onto another', async () => {
    const alice = await makeUser();
    const bob = await makeUser({ email: 'bob@example.com', username: 'bob' });

    await expect(
      users.updateUserProfile({ userId: bob.id, username: 'ALICE' })
    ).rejects.toMatchObject({ status: 409 });
    expect(alice.username).toBe('alice');
  });

  it('does not stop an account keeping the name it already has', async () => {
    const alice = await makeUser();

    const updated = await users.updateUserProfile({
      userId: alice.id,
      username: 'alice',
      displayName: 'Alice A.',
    });

    expect(updated.displayName).toBe('Alice A.');
  });

  it('does not stop an account clearing its username', async () => {
    const alice = await makeUser();

    const updated = await users.updateUserProfile({ userId: alice.id, username: '' });

    expect(updated.username).toBeNull();
  });

  /** An account with no username is not an account named "". */
  it('is not what two accounts without a username are', async () => {
    await makeUser({ username: null });
    await makeUser({ email: 'bob@example.com', username: null });

    expect(await signIn('')).toBeNull();
  });

  /**
   * An older version could store an empty string rather than nothing. It names
   * no account, so it must not stop the next account being created without a
   * username of its own.
   */
  it('is not what an account with an empty username is', async () => {
    const alice = await makeUser();
    const db = await envContext.requireFresh('src/services/db').getDb();
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run('', alice.id);

    await expect(makeUser({ email: 'bob@example.com', username: null })).resolves.toBeTruthy();
    expect(await signIn('')).toBeNull();
  });
});

describe('the lockout after failed attempts', () => {
  beforeEach(async () => {
    await build();
    await makeUser();
  });

  it('locks the account after enough of them', async () => {
    await signIn('alice', 'faux');
    await signIn('alice', 'faux');
    await signIn('alice', 'faux');

    await expect(signIn('alice')).rejects.toMatchObject({ status: 423 });
  });

  /**
   * One account, two names, one budget. Keyed on what was typed, alternating
   * between the address and the username would have given twice the attempts —
   * and with the lock never tripping, indefinitely many.
   */
  it('counts attempts against the account, not against the name used', async () => {
    await signIn('alice', 'faux');
    await signIn('alice@example.com', 'faux');
    await signIn('ALICE', 'faux');

    await expect(signIn('alice@example.com')).rejects.toMatchObject({ status: 423 });
  });

  it('locks the account whichever name is tried afterwards', async () => {
    await signIn('alice@example.com', 'faux');
    await signIn('alice@example.com', 'faux');
    await signIn('alice@example.com', 'faux');

    await expect(signIn('alice')).rejects.toMatchObject({ status: 423 });
  });

  it('forgets the attempts once one of them works', async () => {
    await signIn('alice', 'faux');
    await signIn('alice', 'faux');

    expect(await signIn('alice')).toBeTruthy();

    await signIn('alice', 'faux');
    await signIn('alice', 'faux');
    expect(await signIn('alice')).toBeTruthy();
  });

  /**
   * A name that belongs to nobody is not counted at all: the lock is per
   * account, and counting for an unknown name would let anyone lock a
   * colleague out by guessing at their address.
   */
  it('counts nothing against a name that belongs to nobody', async () => {
    await signIn('mallory', 'faux');
    await signIn('mallory', 'faux');
    await signIn('mallory', 'faux');
    await signIn('mallory', 'faux');

    expect(await signIn('mallory')).toBeNull();
  });

  /**
   * An account that signs in through an identity provider has no password
   * here. Guessing at one is still guessing, and still counted.
   */
  it('counts attempts against an account that has no password', async () => {
    const db = await envContext.requireFresh('src/services/db').getDb();
    const alice = db.prepare('SELECT id FROM users WHERE email = ?').get('alice@example.com');
    db.prepare('DELETE FROM auth_methods WHERE user_id = ?').run(alice.id);

    await signIn('alice', 'faux');
    await signIn('alice', 'faux');
    await signIn('alice', 'faux');

    await expect(signIn('alice')).rejects.toMatchObject({ status: 423 });
  });

  it('does not lock one account out by failing on another', async () => {
    await makeUser({ email: 'bob@example.com', username: 'bob' });

    await signIn('bob', 'faux');
    await signIn('bob', 'faux');
    await signIn('bob', 'faux');

    expect(await signIn('alice')).toBeTruthy();
  });
});
