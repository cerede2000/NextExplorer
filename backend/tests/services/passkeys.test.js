import { describe, it, expect, afterEach } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

const { createCredential, signAssertion } = require('../helpers/soft-authenticator');

/**
 * What the passkey store holds, and what it refuses to let go of.
 *
 * The routes cover a browser signing in; this covers the cases a browser
 * cannot reach — an account with no password left, a credential belonging to
 * somebody else, a counter going backwards — because each of them is a way in
 * or a way to be locked out.
 */

const RP_ID = 'files.example.test';
const ORIGIN = 'https://files.example.test';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'passkeys-service-' });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  const addUser = db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
  );
  addUser.run('u1', 'someone@example.com', 'someone', 'Someone', now, now);
  addUser.run('u2', 'other@example.com', 'other', 'Other', now, now);

  const passkeys = currentEnv.requireFresh('src/services/users/passkeys');
  return { db, passkeys };
};

/** A password on an account, of the kind `hasPassword` looks for. */
const givePassword = (db, userId) =>
  db
    .prepare(
      `INSERT INTO auth_methods (id, user_id, method_type, password_hash, password_algo, created_at)
       VALUES (?, ?, 'local_password', 'not-a-real-hash', 'bcrypt', ?)`
    )
    .run(`m-${userId}`, userId, new Date().toISOString());

/** Register one through the service, the way the route does. */
const enrol = async ({ passkeys, userId = 'u1', name, ...options }) => {
  const started = await passkeys.beginRegistration({
    userId,
    account: 'someone@example.com',
    rpId: RP_ID,
    rpName: 'Files',
  });
  const credential = createCredential({
    challenge: started.challenge,
    rpId: RP_ID,
    origin: ORIGIN,
    ...options,
  });
  const passkey = await passkeys.finishRegistration({
    userId,
    name,
    response: {
      attestationObject: credential.attestationObject.toString('base64url'),
      clientDataJSON: credential.clientDataJSON.toString('base64url'),
    },
    expected: { challenge: started.challenge, origins: [ORIGIN], rpId: RP_ID },
  });
  return { credential, passkey };
};

const useIt = async ({ passkeys, credential, signCount = 1 }) => {
  const started = passkeys.beginAuthentication({ rpId: RP_ID });
  const assertion = signAssertion({
    credential,
    challenge: started.challenge,
    rpId: RP_ID,
    origin: ORIGIN,
    signCount,
  });
  return passkeys.finishAuthentication({
    response: {
      id: credential.credentialId.toString('base64url'),
      authenticatorData: assertion.authenticatorData.toString('base64url'),
      clientDataJSON: assertion.clientDataJSON.toString('base64url'),
      signature: assertion.signature.toString('base64url'),
    },
    expected: { challenge: started.challenge, origins: [ORIGIN], rpId: RP_ID },
  });
};

describe('keeping a passkey', () => {
  it('finds the account it belongs to when it is used', async () => {
    const { passkeys } = await seed();
    const { credential } = await enrol({ passkeys });

    expect(await useIt({ passkeys, credential })).toMatchObject({
      userId: 'u1',
      userVerified: true,
    });
  });

  it('remembers the counter, so the next signature has to beat it', async () => {
    const { passkeys, db } = await seed();
    const { credential } = await enrol({ passkeys });

    await useIt({ passkeys, credential, signCount: 30 });

    expect(db.prepare('SELECT sign_count FROM passkeys').get().sign_count).toBe(30);
    await expect(useIt({ passkeys, credential, signCount: 30 })).rejects.toThrow(/used before/);
    await expect(useIt({ passkeys, credential, signCount: 29 })).rejects.toThrow(/used before/);
    expect(await useIt({ passkeys, credential, signCount: 31 })).toMatchObject({ userId: 'u1' });
  });

  it('refuses a credential another account already holds', async () => {
    const { passkeys } = await seed();
    const { credential } = await enrol({ passkeys, userId: 'u1' });

    await expect(
      enrol({ passkeys, userId: 'u2', credentialId: credential.credentialId })
    ).rejects.toThrow(/already in use/);
  });

  it('says so when the account already holds it', async () => {
    const { passkeys } = await seed();
    const { credential } = await enrol({ passkeys });

    await expect(
      enrol({ passkeys, userId: 'u1', credentialId: credential.credentialId })
    ).rejects.toThrow(/already on your account/);
  });

  it('keeps a name readable, and falls back to one that counts', async () => {
    const { passkeys } = await seed();

    await enrol({ passkeys, name: `a${String.fromCharCode(9)}b` });
    const second = await enrol({ passkeys, name: '   ' });
    const third = await enrol({ passkeys, name: 'x'.repeat(200) });

    const held = await passkeys.listPasskeys('u1');
    expect(held.map((p) => p.name)).toEqual(
      expect.arrayContaining(['a b', 'Passkey 2', 'x'.repeat(60)])
    );
    expect(second.passkey.name).toBe('Passkey 2');
    expect(third.passkey.name).toHaveLength(60);
  });
});

describe('taking one away', () => {
  it('refuses the last one when it is the whole way in', async () => {
    const { passkeys } = await seed();
    const { passkey } = await enrol({ passkeys });

    expect(await passkeys.deletePasskey({ userId: 'u1', id: passkey.id })).toEqual({
      removed: false,
      reason: 'last-way-in',
    });
    expect(await passkeys.countPasskeys('u1')).toBe(1);
  });

  it('allows it once there is another one', async () => {
    const { passkeys } = await seed();
    const { passkey } = await enrol({ passkeys });
    await enrol({ passkeys });

    expect(await passkeys.deletePasskey({ userId: 'u1', id: passkey.id })).toEqual({
      removed: true,
    });
    expect(await passkeys.countPasskeys('u1')).toBe(1);
  });

  it('allows the last one when a password can still open the account', async () => {
    const { passkeys, db } = await seed();
    givePassword(db, 'u1');
    const { passkey } = await enrol({ passkeys });

    expect(await passkeys.hasPassword('u1')).toBe(true);
    expect(await passkeys.deletePasskey({ userId: 'u1', id: passkey.id })).toEqual({
      removed: true,
    });
  });

  it('will not take one from an account that does not hold it', async () => {
    const { passkeys } = await seed();
    const { passkey } = await enrol({ passkeys, userId: 'u1' });
    await enrol({ passkeys, userId: 'u1' });

    expect(await passkeys.deletePasskey({ userId: 'u2', id: passkey.id })).toEqual({
      removed: false,
      reason: 'missing',
    });
    expect(await passkeys.countPasskeys('u1')).toBe(2);
  });

  it('will not rename one that belongs to another account', async () => {
    const { passkeys } = await seed();
    const { passkey } = await enrol({ passkeys, userId: 'u1', name: 'Mine' });

    expect(
      await passkeys.renamePasskey({ userId: 'u2', id: passkey.id, name: 'Yours' })
    ).toBeNull();
    expect((await passkeys.listPasskeys('u1'))[0].name).toBe('Mine');
  });

  it('takes them all when an administrator hands an account back', async () => {
    const { passkeys } = await seed();
    await enrol({ passkeys });
    await enrol({ passkeys });

    expect(await passkeys.deleteAllPasskeys('u1')).toBe(2);
    expect(await passkeys.listPasskeys('u1')).toEqual([]);
  });

  it('goes with the account it belonged to', async () => {
    const { passkeys, db } = await seed();
    await enrol({ passkeys });

    db.prepare('DELETE FROM users WHERE id = ?').run('u1');

    expect(db.prepare('SELECT COUNT(*) AS total FROM passkeys').get().total).toBe(0);
  });
});
