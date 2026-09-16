import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Signing in with a second factor.
 *
 * Wired the way the application wires it — the SQLite session store, then the
 * auth middleware — because what is being pinned is what a half-finished
 * sign-in can reach. A password that is right and a code that is missing must
 * open nothing at all, and `/api/users/shareable` is the plainest route that
 * says whether anything is open.
 *
 * Passwords are hashed with bcrypt at cost 12 throughout, hence the timeout.
 */

const PASSWORD = 'secret123';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const build = async () => {
  currentEnv = await setupTestEnv({
    tag: 'two-factor-auth-',
    env: { AUTH_ENABLED: 'true', AUTH_MODE: 'local' },
  });
  const { configureSession } = currentEnv.requireFresh('src/middleware/session');
  const authMiddleware = currentEnv.requireFresh('src/middleware/authMiddleware');
  const authRoutes = currentEnv.requireFresh('src/routes/auth');
  const userRoutes = currentEnv.requireFresh('src/routes/users');
  const { errorHandler, notFoundHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const { totpCode } = currentEnv.requireFresh('src/utils/totp');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  configureSession(app);
  app.use(authMiddleware);
  app.use('/api/auth', authRoutes);
  app.use('/api', userRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, totpCode };
};

/** The first administrator, signed in through the setup. */
const setUpOwner = async (app) => {
  const browser = request.agent(app);
  const response = await browser
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD });
  expect(response.status).toBe(201);
  return browser;
};

/** Whether this browser can reach something that needs an account. */
const signedIn = async (browser) => (await browser.get('/api/users/shareable')).status === 200;

/** Set up an authenticator on the signed-in account, and keep its secret. */
const turnOn = async (browser, totpCode) => {
  const started = await browser.post('/api/auth/totp/start').send({});
  expect(started.status).toBe(200);
  const confirmed = await browser
    .post('/api/auth/totp/confirm')
    .send({ code: totpCode(started.body.secret) });
  expect(confirmed.status).toBe(200);
  return { secret: started.body.secret, recoveryCodes: confirmed.body.recoveryCodes };
};

describe('turning it on', { timeout: 30_000 }, () => {
  it('shows a secret, and asks for a code before it counts', async () => {
    const { app, totpCode } = await build();
    const browser = await setUpOwner(app);

    const started = await browser.post('/api/auth/totp/start').send({});

    expect(started.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.body.uri).toContain('otpauth://totp/');
    expect((await browser.get('/api/auth/totp')).body).toMatchObject({
      enabled: false,
      pending: true,
    });

    const wrong = await browser.post('/api/auth/totp/confirm').send({ code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('AUTH_INVALID_TOTP_CODE');
    expect((await browser.get('/api/auth/totp')).body.enabled).toBe(false);

    const right = await browser
      .post('/api/auth/totp/confirm')
      .send({ code: totpCode(started.body.secret) });

    expect(right.status).toBe(200);
    expect(right.body.recoveryCodes).toHaveLength(10);
    expect((await browser.get('/api/auth/totp')).body).toMatchObject({
      enabled: true,
      recoveryCodesLeft: 10,
    });
  });

  it('refuses to set one up for somebody who is not signed in', async () => {
    const { app } = await build();
    await setUpOwner(app);

    const stranger = request.agent(app);
    expect((await stranger.post('/api/auth/totp/start').send({})).status).toBe(401);
    expect((await stranger.get('/api/auth/totp')).status).toBe(401);
  });
});

describe('signing in with it', { timeout: 30_000 }, () => {
  it('opens nothing on the password alone', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    await turnOn(owner, totpCode);

    const browser = request.agent(app);
    const first = await browser
      .post('/api/auth/login')
      .send({ identifier: 'owner', password: PASSWORD });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ totpRequired: true });
    expect(first.body.user).toBeUndefined();
    expect(await signedIn(browser)).toBe(false);
    // A reload lands back on the code rather than on the password.
    expect((await browser.get('/api/auth/status')).body.totpPending).toBe(true);
  });

  it('finishes on the code the phone shows', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    const { secret } = await turnOn(owner, totpCode);

    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });
    const second = await browser
      .post('/api/auth/login/totp')
      .send({ code: totpCode(secret, { at: Date.now() + 30_000 }) });

    expect(second.status).toBe(200);
    expect(second.body.user.username).toBe('owner');
    expect(second.body.usedRecoveryCode).toBe(false);
    expect(await signedIn(browser)).toBe(true);
    expect((await browser.get('/api/auth/status')).body.totpPending).toBe(false);
  });

  it('refuses a wrong code and leaves the sign-in waiting', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    const { secret } = await turnOn(owner, totpCode);

    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });

    const refused = await browser.post('/api/auth/login/totp').send({ code: '000000' });
    expect(refused.status).toBe(401);
    // Its own code, so a screen can say "that code" rather than "those
    // credentials": the password was right, and saying otherwise sends
    // somebody looking for the wrong mistake.
    expect(refused.body.error.code).toBe('AUTH_INVALID_TOTP_CODE');
    expect(await signedIn(browser)).toBe(false);

    const second = await browser
      .post('/api/auth/login/totp')
      .send({ code: totpCode(secret, { at: Date.now() + 30_000 }) });
    expect(second.status).toBe(200);
  });

  /** Six digits are worth one sign-in, through the API as much as anywhere. */
  it('refuses the same code for a second sign-in', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    const { secret } = await turnOn(owner, totpCode);
    const code = totpCode(secret, { at: Date.now() + 30_000 });

    const first = request.agent(app);
    await first.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });
    expect((await first.post('/api/auth/login/totp').send({ code })).status).toBe(200);

    const second = request.agent(app);
    await second.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });
    expect((await second.post('/api/auth/login/totp').send({ code })).status).toBe(401);
    expect(await signedIn(second)).toBe(false);
  });

  it('takes a recovery code, and says how many are left', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    const { recoveryCodes } = await turnOn(owner, totpCode);

    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });
    const second = await browser.post('/api/auth/login/totp').send({ code: recoveryCodes[0] });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ usedRecoveryCode: true, recoveryCodesLeft: 9 });
    expect(await signedIn(browser)).toBe(true);
  });

  /**
   * Nothing to finish: a code on its own is not a sign-in, and whose sign-in it
   * would be is the server's to know. The body here tries to say — which is the
   * whole of the attack, a correct code and a chosen account — and is ignored.
   */
  it('refuses a code with no sign-in waiting for it, whoever the body names', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    const { secret } = await turnOn(owner, totpCode);
    const me = (await owner.get('/api/auth/status')).body.user;

    const stranger = request.agent(app);
    const response = await stranger.post('/api/auth/login/totp').send({
      // A code that would be accepted: a step later than the one the setup
      // spent, so what refuses this is the missing sign-in and nothing else.
      code: totpCode(secret, { at: Date.now() + 30_000 }),
      userId: me.id,
      identifier: 'owner',
      email: 'owner@example.com',
    });

    expect(response.status).toBe(401);
    expect(await signedIn(stranger)).toBe(false);
  });

  /**
   * A machine walked away from, halfway through signing in, is not a sign-in
   * waiting to be finished by whoever sits down next.
   */
  it('lets the second step go stale, and asks for the password again', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    const { secret } = await turnOn(owner, totpCode);

    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });

    // Six minutes later, on a step of its own so the code itself is still good.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const later = Date.now() + 6 * 60 * 1000;
      vi.setSystemTime(later);
      const response = await browser
        .post('/api/auth/login/totp')
        .send({ code: totpCode(secret, { at: later }) });

      expect(response.status).toBe(401);
      expect(await signedIn(browser)).toBe(false);
      expect((await browser.get('/api/auth/status')).body.totpPending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an account without one signing in as it always did', async () => {
    const { app } = await build();
    await setUpOwner(app);

    const browser = request.agent(app);
    const response = await browser
      .post('/api/auth/login')
      .send({ identifier: 'owner', password: PASSWORD });

    expect(response.body.user.username).toBe('owner');
    expect(response.body.totpRequired).toBeUndefined();
    expect(await signedIn(browser)).toBe(true);
  });
});

describe('turning it off, and drawing new codes', { timeout: 30_000 }, () => {
  it('asks for the password before taking it off', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    await turnOn(owner, totpCode);

    const refused = await owner.delete('/api/auth/totp').send({ password: 'not-the-password' });

    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('AUTH_PASSWORD_INCORRECT');
    expect((await owner.get('/api/auth/totp')).body.enabled).toBe(true);

    const accepted = await owner.delete('/api/auth/totp').send({ password: PASSWORD });

    expect(accepted.status).toBe(204);
    expect((await owner.get('/api/auth/totp')).body).toMatchObject({
      enabled: false,
      recoveryCodesLeft: 0,
    });
  });

  it('asks for the password before drawing new recovery codes, and retires the old ones', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    const { recoveryCodes } = await turnOn(owner, totpCode);

    const refused = await owner.post('/api/auth/totp/recovery-codes').send({ password: 'wrong' });
    expect(refused.status).toBe(401);

    const fresh = await owner.post('/api/auth/totp/recovery-codes').send({ password: PASSWORD });
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    expect(fresh.body.recoveryCodes).not.toContain(recoveryCodes[0]);

    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });
    expect(
      (await browser.post('/api/auth/login/totp').send({ code: recoveryCodes[0] })).status
    ).toBe(401);
  });

  /** Signing in again after it is off asks for nothing but the password. */
  it('goes back to one step once it is off', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    await turnOn(owner, totpCode);
    await owner.delete('/api/auth/totp').send({ password: PASSWORD });

    const browser = request.agent(app);
    const response = await browser
      .post('/api/auth/login')
      .send({ identifier: 'owner', password: PASSWORD });

    expect(response.body.user.username).toBe('owner');
    expect(await signedIn(browser)).toBe(true);
  });
});

/**
 * The phone in the bag that was stolen with the printout.
 *
 * Somebody has to be able to take it off, and that somebody is whoever can
 * already reset the account's password: an administrator. Anyone else asking
 * is told no, and the account keeps asking for its code.
 */
describe('an administrator taking it off', { timeout: 30_000 }, () => {
  const createRegular = async (owner) =>
    (
      await owner.post('/api/users').send({
        email: 'regular@example.com',
        username: 'regular',
        password: PASSWORD,
        roles: ['user'],
      })
    ).body.user;

  it('takes it off, and the account signs in with its password alone', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    const regular = await createRegular(owner);

    const theirs = request.agent(app);
    await theirs.post('/api/auth/login').send({ identifier: 'regular', password: PASSWORD });
    await turnOn(theirs, totpCode);

    expect(
      (await owner.get('/api/users')).body.users.find((u) => u.id === regular.id)
    ).toMatchObject({ twoFactorEnabled: true });

    expect((await owner.delete(`/api/users/${regular.id}/two-factor`)).status).toBe(204);

    const again = request.agent(app);
    const response = await again
      .post('/api/auth/login')
      .send({ identifier: 'regular', password: PASSWORD });

    expect(response.body.user.username).toBe('regular');
    expect(await signedIn(again)).toBe(true);
  });

  it('refuses anybody who is not an administrator', async () => {
    const { app, totpCode } = await build();
    const owner = await setUpOwner(app);
    const regular = await createRegular(owner);

    const theirs = request.agent(app);
    await theirs.post('/api/auth/login').send({ identifier: 'regular', password: PASSWORD });
    await turnOn(theirs, totpCode);

    const response = await theirs.delete(`/api/users/${regular.id}/two-factor`);

    expect(response.status).toBe(403);
    expect((await theirs.get('/api/auth/totp')).body.enabled).toBe(true);
  });
});
