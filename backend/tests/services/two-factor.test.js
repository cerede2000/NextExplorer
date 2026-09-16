import { describe, it, expect, afterEach } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A second factor on a local account.
 *
 * What has to hold is mostly about what happens when things go wrong: a setup
 * abandoned halfway leaves nobody locked out, a code is worth one login and
 * not two, a recovery code is worth one use, and losing the key the secret was
 * written under costs an authenticator rather than an account.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'two-factor-' });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1','someone@example.com',1,'someone','Someone','["user"]', ?, ?)`
  ).run(now, now);

  const twoFactor = currentEnv.requireFresh('src/services/users/twoFactor');
  const { totpCode } = currentEnv.requireFresh('src/utils/totp');
  return { db, twoFactor, totpCode };
};

/** Signed up, confirmed, and holding its recovery codes. */
const turnOn = async ({ twoFactor, totpCode }) => {
  const { secret } = await twoFactor.beginEnrolment({
    userId: 'u1',
    account: 'someone@example.com',
  });
  const confirmed = await twoFactor.confirmEnrolment({ userId: 'u1', code: totpCode(secret) });
  expect(confirmed).not.toBeNull();
  return { secret, recoveryCodes: confirmed.recoveryCodes };
};

describe('setting it up', () => {
  it('hands out a secret and an address the phone can read, and turns nothing on yet', async () => {
    const { twoFactor } = await seed();

    const { secret, uri } = await twoFactor.beginEnrolment({
      userId: 'u1',
      account: 'someone@example.com',
    });

    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('someone%40example.com');
    expect(await twoFactor.twoFactorRequired('u1')).toBe(false);
    expect(await twoFactor.twoFactorStatus('u1')).toMatchObject({ enabled: false, pending: true });
  });

  /** A page left open yesterday is not a second authenticator. */
  it('replaces an unconfirmed secret rather than keeping both', async () => {
    const { twoFactor, totpCode } = await seed();
    const first = await twoFactor.beginEnrolment({ userId: 'u1', account: 'someone' });
    const second = await twoFactor.beginEnrolment({ userId: 'u1', account: 'someone' });

    expect(second.secret).not.toBe(first.secret);
    expect(
      await twoFactor.confirmEnrolment({ userId: 'u1', code: totpCode(first.secret) })
    ).toBeNull();
    expect(
      await twoFactor.confirmEnrolment({ userId: 'u1', code: totpCode(second.secret) })
    ).not.toBeNull();
  });

  it('refuses a wrong code, and leaves it off', async () => {
    const { twoFactor } = await seed();
    await twoFactor.beginEnrolment({ userId: 'u1', account: 'someone' });

    expect(await twoFactor.confirmEnrolment({ userId: 'u1', code: '000000' })).toBeNull();
    expect(await twoFactor.twoFactorRequired('u1')).toBe(false);
  });

  it('turns it on with ten recovery codes, handed over once', async () => {
    const { twoFactor, totpCode } = await seed();
    const { recoveryCodes } = await turnOn({ twoFactor, totpCode });

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(await twoFactor.twoFactorStatus('u1')).toMatchObject({
      enabled: true,
      recoveryCodesLeft: 10,
    });
  });

  it('refuses to start again while it is on', async () => {
    const { twoFactor, totpCode } = await seed();
    await turnOn({ twoFactor, totpCode });

    await expect(twoFactor.beginEnrolment({ userId: 'u1', account: 'someone' })).rejects.toThrow();
  });
});

describe('signing in with it', () => {
  it('takes the code the phone shows', async () => {
    const { twoFactor, totpCode } = await seed();
    const { secret } = await turnOn({ twoFactor, totpCode });

    // A step later than the one the confirmation spent.
    const at = Date.now() + 30_000;
    const code = totpCode(secret, { at });
    expect(await twoFactor.verifySecondFactor({ userId: 'u1', code })).toMatchObject({ ok: true });
  });

  /**
   * Six digits are good for thirty seconds and for one sign-in. Read over a
   * shoulder, or found in a proxy's log, they are already spent.
   */
  it('refuses the same code twice', async () => {
    const { twoFactor, totpCode } = await seed();
    const { secret } = await turnOn({ twoFactor, totpCode });
    const at = Date.now() + 30_000;
    const code = totpCode(secret, { at });

    expect(await twoFactor.verifySecondFactor({ userId: 'u1', code })).toMatchObject({ ok: true });
    expect(await twoFactor.verifySecondFactor({ userId: 'u1', code })).toMatchObject({ ok: false });
  });

  it('refuses a wrong code', async () => {
    const { twoFactor, totpCode } = await seed();
    await turnOn({ twoFactor, totpCode });

    expect(await twoFactor.verifySecondFactor({ userId: 'u1', code: '000000' })).toMatchObject({
      ok: false,
    });
  });

  it('takes a recovery code, once, and says how many are left', async () => {
    const { twoFactor, totpCode } = await seed();
    const { recoveryCodes } = await turnOn({ twoFactor, totpCode });
    const [paper] = recoveryCodes;

    expect(await twoFactor.verifySecondFactor({ userId: 'u1', code: paper })).toMatchObject({
      ok: true,
      usedRecoveryCode: true,
      recoveryCodesLeft: 9,
    });
    expect(await twoFactor.verifySecondFactor({ userId: 'u1', code: paper })).toMatchObject({
      ok: false,
    });
  });

  /** Read off a printout, typed back in whatever case and spacing. */
  it('reads a recovery code however it was typed', async () => {
    const { twoFactor, totpCode } = await seed();
    const { recoveryCodes } = await turnOn({ twoFactor, totpCode });
    const typed = recoveryCodes[0].toLowerCase().replace('-', ' ');

    expect(await twoFactor.verifySecondFactor({ userId: 'u1', code: typed })).toMatchObject({
      ok: true,
    });
  });

  /**
   * A setup somebody walked away from is not a second factor. Nothing asks for
   * one yet either, so this is the belt to that pair of braces: the code that
   * checks a factor refuses a secret no phone ever confirmed.
   */
  it('refuses a code for a secret that was never confirmed', async () => {
    const { twoFactor, totpCode } = await seed();
    const { secret } = await twoFactor.beginEnrolment({ userId: 'u1', account: 'someone' });

    expect(
      await twoFactor.verifySecondFactor({ userId: 'u1', code: totpCode(secret) })
    ).toMatchObject({ ok: false });
  });

  it('asks nothing of an account that never set it up', async () => {
    const { twoFactor } = await seed();

    expect(await twoFactor.twoFactorRequired('u1')).toBe(false);
    expect(await twoFactor.verifySecondFactor({ userId: 'u1', code: '000000' })).toMatchObject({
      ok: false,
    });
  });

  /**
   * The key beside the database is gone or was replaced. The secret cannot be
   * read, so the phone is no help — and this is exactly the case recovery codes
   * exist for, so they still let somebody in to set it up again.
   */
  it('still takes a recovery code when the secret can no longer be read', async () => {
    const { db, twoFactor, totpCode } = await seed();
    const { secret, recoveryCodes } = await turnOn({ twoFactor, totpCode });
    db.prepare('UPDATE totp_credentials SET secret = ? WHERE user_id = ?').run(
      'v1:AAAA:BBBB:CCCC',
      'u1'
    );

    const at = Date.now() + 30_000;
    expect(
      await twoFactor.verifySecondFactor({ userId: 'u1', code: totpCode(secret, { at }) })
    ).toMatchObject({ ok: false });
    expect(
      await twoFactor.verifySecondFactor({ userId: 'u1', code: recoveryCodes[1] })
    ).toMatchObject({ ok: true });
  });
});

describe('afterwards', () => {
  it('draws new recovery codes, and the old ones stop working', async () => {
    const { twoFactor, totpCode } = await seed();
    const { recoveryCodes } = await turnOn({ twoFactor, totpCode });

    const fresh = await twoFactor.replaceRecoveryCodes('u1');

    expect(fresh).toHaveLength(10);
    expect(
      await twoFactor.verifySecondFactor({ userId: 'u1', code: recoveryCodes[0] })
    ).toMatchObject({ ok: false });
    expect(await twoFactor.verifySecondFactor({ userId: 'u1', code: fresh[0] })).toMatchObject({
      ok: true,
    });
  });

  it('will not draw codes for an account that has it off', async () => {
    const { twoFactor } = await seed();
    await expect(twoFactor.replaceRecoveryCodes('u1')).rejects.toThrow();
  });

  it('takes it off, secret and codes both', async () => {
    const { db, twoFactor, totpCode } = await seed();
    await turnOn({ twoFactor, totpCode });

    expect(await twoFactor.disableTwoFactor('u1')).toBe(true);

    expect(await twoFactor.twoFactorRequired('u1')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM totp_credentials').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM totp_recovery_codes').get().n).toBe(0);
  });
});

describe('what the database holds', () => {
  it('keeps the secret unreadable in the row', async () => {
    const { db, twoFactor, totpCode } = await seed();
    const { secret } = await turnOn({ twoFactor, totpCode });

    const stored = db.prepare('SELECT secret FROM totp_credentials WHERE user_id = ?').get('u1');

    expect(stored.secret).not.toContain(secret);
    expect(stored.secret.startsWith('v1:')).toBe(true);
  });

  it('keeps recovery codes hashed', async () => {
    const { db, twoFactor, totpCode } = await seed();
    const { recoveryCodes } = await turnOn({ twoFactor, totpCode });

    const rows = db.prepare('SELECT code_hash FROM totp_recovery_codes').all();

    for (const row of rows) {
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(recoveryCodes).not.toContain(row.code_hash);
    }
  });
});
