import express from 'express';
import request from 'supertest';
import session from 'express-session';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A second factor on a local account.
 *
 * A password is the whole of what stood between somebody's files and whoever
 * had that password — from a reused one, a phishing page, a machine left
 * signed in somewhere else. A code from an authenticator answers all three,
 * and the recovery codes answer the obvious objection to it.
 *
 * Two things here are worth stating plainly, because they are the difference
 * between a second factor and the appearance of one: the password step does
 * not sign anybody in, and a wrong code counts against the same lockout a
 * wrong password does.
 */

let env;
let app;
let alice;

const load = (relative) => require(modulePath(relative));

const PASSWORD = 'secret123';

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'two-factor-' });
  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: PASSWORD,
    roles: ['user'],
  });

  app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'two-factor-tests',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use('/api/auth', load('src/routes/auth'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

/** One browser: a cookie jar that survives between requests. */
const agent = () => request.agent(app);

const signIn = (client, password = PASSWORD) =>
  client.post('/api/auth/login').send({ email: 'alice@example.com', password });

/** Turn it on the way the account screen does, and keep what it shows once. */
const turnOn = async (client) => {
  await signIn(client);
  const started = await client.post('/api/auth/totp/start').send({});
  expect(started.status).toBe(200);
  const totp = load('src/utils/totp');
  // Confirmed with the previous step's code, which the window still accepts.
  // A code is good for one sign-in, so confirming with the current one would
  // leave nothing for the sign-in that follows to use — see the test below.
  const code = totp.totpCode(started.body.secret, { at: Date.now() - 30_000 });
  const confirmed = await client.post('/api/auth/totp/confirm').send({ code });
  expect(confirmed.status).toBe(200);
  return { secret: started.body.secret, recoveryCodes: confirmed.body.recoveryCodes };
};

describe('turning a second factor on', () => {
  it('changes nothing until a code proves the phone holds the same secret', async () => {
    const client = agent();
    await signIn(client);
    await client.post('/api/auth/totp/start').send({});

    // Still nothing: the secret was drawn, not confirmed.
    const again = agent();
    const signedIn = await signIn(again);
    expect(signedIn.body.totpRequired).toBeUndefined();
    expect(signedIn.body.user).toBeTruthy();
  });

  it('hands over recovery codes once, and asks for a code from then on', async () => {
    const client = agent();
    const { recoveryCodes } = await turnOn(client);

    expect(recoveryCodes.length).toBeGreaterThan(0);

    const fresh = agent();
    const signedIn = await signIn(fresh);
    expect(signedIn.body).toEqual({ totpRequired: true });
    expect(signedIn.body.user).toBeUndefined();
  });

  it('is refused to somebody who did not sign in with their password', async () => {
    const client = agent();
    await turnOn(client);
    // A second browser that only got as far as the password step.
    const half = agent();
    await signIn(half);

    expect((await half.post('/api/auth/totp/start').send({})).status).toBe(401);
  });
});

describe('the second step', () => {
  it('signs in with the code from the authenticator', async () => {
    const client = agent();
    const { secret } = await turnOn(client);
    const fresh = agent();
    await signIn(fresh);

    const finished = await fresh
      .post('/api/auth/login/totp')
      .send({ code: load('src/utils/totp').totpCode(secret) });

    expect(finished.status).toBe(200);
    expect(finished.body.user.email).toBe('alice@example.com');
    expect(finished.body.usedRecoveryCode).toBe(false);
  });

  /** Thirty seconds, and one sign-in: a code seen once is spent. */
  it('refuses the same code a second time', async () => {
    const client = agent();
    const { secret } = await turnOn(client);
    const code = load('src/utils/totp').totpCode(secret);

    const first = agent();
    await signIn(first);
    expect((await first.post('/api/auth/login/totp').send({ code })).status).toBe(200);

    const second = agent();
    await signIn(second);
    expect((await second.post('/api/auth/login/totp').send({ code })).status).toBe(401);
  });

  it('signs in with a recovery code, once', async () => {
    const client = agent();
    const { recoveryCodes } = await turnOn(client);
    const fresh = agent();
    await signIn(fresh);

    const finished = await fresh.post('/api/auth/login/totp').send({ code: recoveryCodes[0] });

    expect(finished.status).toBe(200);
    expect(finished.body.usedRecoveryCode).toBe(true);

    // The same code again is no longer a way in.
    const third = agent();
    await signIn(third);
    expect((await third.post('/api/auth/login/totp').send({ code: recoveryCodes[0] })).status).toBe(
      401
    );
  });

  /**
   * The password step must not be a session with a flag on it: nothing but the
   * account id on the session signs anybody in, and this state does not set it.
   */
  it('is not signed in between the password and the code', async () => {
    const client = agent();
    await turnOn(client);
    const fresh = agent();
    await signIn(fresh);

    const me = await fresh.get('/api/auth/me');

    expect(me.body.user ?? null).toBeNull();
  });

  it('refuses a code for a sign-in nobody started', async () => {
    const client = agent();
    await turnOn(client);

    const stranger = agent();
    expect((await stranger.post('/api/auth/login/totp').send({ code: '000000' })).status).toBe(401);
  });

  /** A wrong code is not a place to guess a million times. */
  it('counts a wrong code against the same lockout a wrong password does', async () => {
    const client = agent();
    await turnOn(client);
    const fresh = agent();
    await signIn(fresh);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await fresh.post('/api/auth/login/totp').send({ code: '000000' });
    }

    const locked = await load('src/services/users/lockout').isLocked(alice.id);
    expect(locked).toBe(true);
  });
});

describe('turning it off, and new recovery codes', () => {
  it('asks for the password first', async () => {
    const client = agent();
    await turnOn(client);

    expect((await client.delete('/api/auth/totp').send({ password: 'wrong' })).status).toBe(401);
    expect(
      (await client.post('/api/auth/totp/recovery-codes').send({ password: 'wrong' })).status
    ).toBe(401);
  });

  it('retires the old recovery codes when new ones are drawn', async () => {
    const client = agent();
    const { recoveryCodes } = await turnOn(client);

    const replaced = await client
      .post('/api/auth/totp/recovery-codes')
      .send({ password: PASSWORD });

    expect(replaced.status).toBe(200);
    expect(replaced.body.recoveryCodes).not.toEqual(recoveryCodes);

    const fresh = agent();
    await signIn(fresh);
    expect((await fresh.post('/api/auth/login/totp').send({ code: recoveryCodes[0] })).status).toBe(
      401
    );
  });

  it('goes back to a password on its own', async () => {
    const client = agent();
    await turnOn(client);

    expect((await client.delete('/api/auth/totp').send({ password: PASSWORD })).status).toBe(204);

    const fresh = agent();
    const signedIn = await signIn(fresh);
    expect(signedIn.body.user).toBeTruthy();
  });
});
