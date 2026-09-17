import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

const { ALGORITHMS, createCredential, signAssertion } = require('../helpers/soft-authenticator');

/**
 * Signing in with a passkey, through the routes that do it.
 *
 * The authenticator is software (tests/helpers/soft-authenticator.js) and the
 * server is wired the way the application wires it — session store, auth
 * middleware, routes — because what is pinned here is what a passkey opens.
 * `/api/users/shareable` is the plainest thing that answers whether anything
 * is open at all.
 *
 * PUBLIC_URL is set, so the site a passkey is bound to is settled and the
 * ceremonies can be written down rather than discovered. One test below takes
 * it away again, to hold the other half: an installation that configured
 * nothing answers for the name the request arrived on.
 *
 * Passwords are hashed with bcrypt at cost 12, hence the timeout.
 */

const PASSWORD = 'secret123';
const PUBLIC_URL = 'https://files.example.test';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const build = async (env = {}) => {
  currentEnv = await setupTestEnv({
    tag: 'passkeys-',
    env: { AUTH_ENABLED: 'true', AUTH_MODE: 'local', PUBLIC_URL, ...env },
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

  /**
   * The same routes, reached by somebody the identity provider signed in.
   *
   * `req.user` without `session.localUserId` is what that looks like from
   * inside a route, and it is the case the passkey routes have to tell apart
   * from a password sign-in.
   */
  const appForProviderSession = (userId) => {
    const provider = express();
    provider.use(express.json());
    provider.use(cookieParser());
    configureSession(provider);
    provider.use((req, _res, next) => {
      req.oidc = { isAuthenticated: () => true };
      req.user = { id: userId, roles: ['user'] };
      next();
    });
    provider.use('/api/auth', authRoutes);
    provider.use(notFoundHandler);
    provider.use(errorHandler);
    return provider;
  };

  return { app, totpCode, appForProviderSession };
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

const signedIn = async (browser) => (await browser.get('/api/users/shareable')).status === 200;

/** Make a passkey on the signed-in account, the way a browser would. */
const addPasskey = async (browser, { name, ...options } = {}) => {
  const started = await browser.post('/api/auth/passkeys/register/start').send({});
  expect(started.status).toBe(200);

  const credential = createCredential({
    challenge: started.body.options.challenge,
    rpId: started.body.options.rp.id,
    origin: started.body.origins[0],
    ...options,
  });
  const finished = await browser.post('/api/auth/passkeys/register/finish').send({
    name,
    response: {
      attestationObject: credential.attestationObject.toString('base64url'),
      clientDataJSON: credential.clientDataJSON.toString('base64url'),
      transports: ['internal', 'hybrid'],
    },
  });

  return { credential, started, finished };
};

/** Sign in with one, from a browser that is signed out. */
const signInWith = async (browser, credential, options = {}) => {
  const started = await browser.post('/api/auth/login/passkey/start').send({});
  expect(started.status).toBe(200);

  const assertion = signAssertion({
    credential,
    challenge: started.body.options.challenge,
    rpId: started.body.options.rpId,
    origin: started.body.origins[0],
    signCount: 1,
    ...options,
  });

  return browser.post('/api/auth/login/passkey/finish').send({
    response: {
      id: credential.credentialId.toString('base64url'),
      authenticatorData: assertion.authenticatorData.toString('base64url'),
      clientDataJSON: assertion.clientDataJSON.toString('base64url'),
      signature: assertion.signature.toString('base64url'),
    },
  });
};

describe('adding a passkey', { timeout: 30_000 }, () => {
  it('keeps it, and lists it under the name it was given', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    const { finished } = await addPasskey(browser, { name: 'The yellow key' });

    expect(finished.status).toBe(201);
    expect(finished.body.passkey).toMatchObject({
      name: 'The yellow key',
      transports: ['internal', 'hybrid'],
    });

    const listed = await browser.get('/api/auth/passkeys');
    expect(listed.body.passkeys).toHaveLength(1);
    expect(listed.body.passkeys[0].lastUsedAt).toBeNull();
  });

  it('names it for them when they do not', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    await addPasskey(browser);
    const second = await addPasskey(browser);

    expect(second.finished.body.passkey.name).toBe('Passkey 2');
  });

  it('asks the browser to skip the ones already on the account', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser);

    const started = await browser.post('/api/auth/passkeys/register/start').send({});

    expect(started.body.options.excludeCredentials).toEqual([
      expect.objectContaining({
        id: credential.credentialId.toString('base64url'),
        type: 'public-key',
      }),
    ]);
  });

  it('offers the algorithms it can actually verify', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    const started = await browser.post('/api/auth/passkeys/register/start').send({});

    expect(started.body.options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8, -257]);
    expect(started.body.options.attestation).toBe('none');
    expect(started.body.options.rp).toEqual({ id: 'files.example.test', name: 'NextExplorer' });
  });

  it('refuses one from somebody who is not signed in', async () => {
    const { app } = await build();
    await setUpOwner(app);
    const stranger = request.agent(app);

    const started = await stranger.post('/api/auth/passkeys/register/start').send({});

    expect(started.status).toBe(401);
  });

  it('refuses an answer to a question this browser was never asked', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const credential = createCredential({
      challenge: 'c29tZXRoaW5nLWVsc2U',
      rpId: 'files.example.test',
      origin: PUBLIC_URL,
    });

    const finished = await browser.post('/api/auth/passkeys/register/finish').send({
      response: {
        attestationObject: credential.attestationObject.toString('base64url'),
        clientDataJSON: credential.clientDataJSON.toString('base64url'),
      },
    });

    expect(finished.status).toBe(400);
  });

  it('refuses one made for another site', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const started = await browser.post('/api/auth/passkeys/register/start').send({});
    const credential = createCredential({
      challenge: started.body.options.challenge,
      rpId: 'evil.test',
      origin: 'https://evil.test',
    });

    const finished = await browser.post('/api/auth/passkeys/register/finish').send({
      response: {
        attestationObject: credential.attestationObject.toString('base64url'),
        clientDataJSON: credential.clientDataJSON.toString('base64url'),
      },
    });

    expect(finished.status).toBe(401);
    expect(finished.body.error.code).toBe('AUTH_PASSKEY_REJECTED');
  });

  it('refuses the same credential twice', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser);

    const started = await browser.post('/api/auth/passkeys/register/start').send({});
    const again = createCredential({
      challenge: started.body.options.challenge,
      rpId: started.body.options.rp.id,
      origin: started.body.origins[0],
      credentialId: credential.credentialId,
    });
    const finished = await browser.post('/api/auth/passkeys/register/finish').send({
      response: {
        attestationObject: again.attestationObject.toString('base64url'),
        clientDataJSON: again.clientDataJSON.toString('base64url'),
      },
    });

    expect(finished.status).toBe(400);
    expect(finished.body.error.message).toMatch(/already/i);
  });

  it('spends the question, so one ceremony makes one passkey', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const started = await browser.post('/api/auth/passkeys/register/start').send({});
    const answer = (credential) => ({
      response: {
        attestationObject: credential.attestationObject.toString('base64url'),
        clientDataJSON: credential.clientDataJSON.toString('base64url'),
      },
    });
    const made = () =>
      createCredential({
        challenge: started.body.options.challenge,
        rpId: started.body.options.rp.id,
        origin: started.body.origins[0],
      });

    expect(
      (await browser.post('/api/auth/passkeys/register/finish').send(answer(made()))).status
    ).toBe(201);
    // A different credential, from the same question: the question is gone.
    const second = await browser.post('/api/auth/passkeys/register/finish').send(answer(made()));

    expect(second.status).toBe(400);
    expect((await browser.get('/api/auth/passkeys')).body.passkeys).toHaveLength(1);
  });

  it('will not let a sign-in question be answered with a new passkey', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    // The challenge is real and this browser was just given it — for the other
    // ceremony. Answering the wrong one is how a signature made for signing in
    // would be offered as a registration.
    const started = await browser.post('/api/auth/login/passkey/start').send({});
    const credential = createCredential({
      challenge: started.body.options.challenge,
      rpId: started.body.options.rpId,
      origin: started.body.origins[0],
    });

    const finished = await browser.post('/api/auth/passkeys/register/finish').send({
      response: {
        attestationObject: credential.attestationObject.toString('base64url'),
        clientDataJSON: credential.clientDataJSON.toString('base64url'),
      },
    });

    expect(finished.status).toBe(400);
    expect((await browser.get('/api/auth/passkeys')).body.passkeys).toEqual([]);
  });

  it('refuses one from a session the identity provider opened', async () => {
    const { app, appForProviderSession } = await build();
    const browser = await setUpOwner(app);
    const me = (await browser.get('/api/auth/status')).body.user;

    const federated = request.agent(appForProviderSession(me.id));
    const started = await federated.post('/api/auth/passkeys/register/start').send({});
    // And the far end of the ceremony, which is the one that would write a row.
    const finished = await federated
      .post('/api/auth/passkeys/register/finish')
      .send({ response: {} });

    expect(started.status).toBe(403);
    expect(finished.status).toBe(403);
    expect((await browser.get('/api/auth/passkeys')).body.passkeys).toEqual([]);
  });

  it('spends the question, so the same answer cannot be given twice', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const started = await browser.post('/api/auth/passkeys/register/start').send({});
    const credential = createCredential({
      challenge: started.body.options.challenge,
      rpId: started.body.options.rp.id,
      origin: started.body.origins[0],
    });
    const body = {
      response: {
        attestationObject: credential.attestationObject.toString('base64url'),
        clientDataJSON: credential.clientDataJSON.toString('base64url'),
      },
    };

    expect((await browser.post('/api/auth/passkeys/register/finish').send(body)).status).toBe(201);
    expect((await browser.post('/api/auth/passkeys/register/finish').send(body)).status).toBe(400);
  });
});

describe('signing in with one', { timeout: 30_000 }, () => {
  it('opens the account, without a password', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});
    expect(await signedIn(browser)).toBe(false);

    const response = await signInWith(browser, credential);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ username: 'owner' });
    expect(await signedIn(browser)).toBe(true);
  });

  it.each([['ES256'], ['EdDSA'], ['RS256']])('takes a %s key', async (name) => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser, { algorithm: ALGORITHMS[name] });
    await browser.post('/api/auth/logout').send({});

    expect((await signInWith(browser, credential)).status).toBe(200);
  });

  it('writes down when it was last used', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});
    await signInWith(browser, credential);

    const listed = await browser.get('/api/auth/passkeys');

    expect(listed.body.passkeys[0].lastUsedAt).toEqual(expect.any(String));
  });

  it('refuses a recording of a sign-in that already happened', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});

    const started = await browser.post('/api/auth/login/passkey/start').send({});
    const assertion = signAssertion({
      credential,
      challenge: started.body.options.challenge,
      rpId: started.body.options.rpId,
      origin: started.body.origins[0],
      signCount: 4,
    });
    const body = {
      response: {
        id: credential.credentialId.toString('base64url'),
        authenticatorData: assertion.authenticatorData.toString('base64url'),
        clientDataJSON: assertion.clientDataJSON.toString('base64url'),
        signature: assertion.signature.toString('base64url'),
      },
    };

    expect((await browser.post('/api/auth/login/passkey/finish').send(body)).status).toBe(200);
    await browser.post('/api/auth/logout').send({});
    // The same answer again, to a question that has been spent.
    expect((await browser.post('/api/auth/login/passkey/finish').send(body)).status).toBe(401);
  });

  it('refuses a passkey that has been used with that counter before', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});

    expect((await signInWith(browser, credential, { signCount: 8 })).status).toBe(200);
    await browser.post('/api/auth/logout').send({});
    const replayed = await signInWith(browser, credential, { signCount: 8 });

    expect(replayed.status).toBe(401);
    expect(replayed.body.error.code).toBe('AUTH_PASSKEY_REJECTED');
  });

  it('refuses a credential it has never seen, saying no more than that', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});
    const stranger = createCredential({ challenge: 'unused', rpId: 'files.example.test' });

    const response = await signInWith(browser, stranger);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AUTH_PASSKEY_REJECTED');
    expect(JSON.stringify(response.body)).not.toMatch(/owner/);
  });

  it('refuses a signature made for another site', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});

    const response = await signInWith(browser, credential, {
      rpId: 'evil.test',
      origin: 'https://evil.test',
    });

    expect(response.status).toBe(401);
    expect(await signedIn(browser)).toBe(false);
  });

  it('refuses one while the account is locked out by wrong passwords', async () => {
    const { app } = await build({ AUTH_MAX_FAILED: '2' });
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await browser.post('/api/auth/login').send({ identifier: 'owner', password: 'wrong' });
    }

    const response = await signInWith(browser, credential);

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('AUTH_ACCOUNT_LOCKED');
    expect(await signedIn(browser)).toBe(false);
  });

  it('refuses an answer with no question behind it', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential } = await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});
    const assertion = signAssertion({
      credential,
      challenge: 'bmV2ZXItYXNrZWQ',
      rpId: 'files.example.test',
      origin: PUBLIC_URL,
    });

    const response = await request
      .agent(app)
      .post('/api/auth/login/passkey/finish')
      .send({
        response: {
          id: credential.credentialId.toString('base64url'),
          authenticatorData: assertion.authenticatorData.toString('base64url'),
          clientDataJSON: assertion.clientDataJSON.toString('base64url'),
          signature: assertion.signature.toString('base64url'),
        },
      });

    expect(response.status).toBe(401);
  });
});

describe('a passkey and a second factor', { timeout: 40_000 }, () => {
  const turnOnTotp = async (browser, totpCode) => {
    const started = await browser.post('/api/auth/totp/start').send({});
    expect(started.status).toBe(200);
    const confirmed = await browser
      .post('/api/auth/totp/confirm')
      .send({ code: totpCode(started.body.secret) });
    expect(confirmed.status).toBe(200);
    return started.body.secret;
  };

  it('is the whole sign-in when the passkey was unlocked', async () => {
    const { app, totpCode } = await build();
    const browser = await setUpOwner(app);
    await turnOnTotp(browser, totpCode);
    const { credential } = await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});

    const response = await signInWith(browser, credential, { userVerified: true });

    expect(response.status).toBe(200);
    expect(response.body.totpRequired).toBeUndefined();
    expect(await signedIn(browser)).toBe(true);
  });

  it('still asks for the code when the passkey was not unlocked', async () => {
    const { app, totpCode } = await build();
    const browser = await setUpOwner(app);
    const secret = await turnOnTotp(browser, totpCode);
    const { credential } = await addPasskey(browser);
    await browser.post('/api/auth/logout').send({});

    const response = await signInWith(browser, credential, { userVerified: false });

    expect(response.body).toEqual({ totpRequired: true });
    expect(await signedIn(browser)).toBe(false);

    // The next window's code: the one that turned it on has been spent.
    const second = await browser
      .post('/api/auth/login/totp')
      .send({ code: totpCode(secret, { at: Date.now() + 30_000 }) });
    expect(second.status).toBe(200);
    expect(await signedIn(browser)).toBe(true);
  });
});

describe('managing them', { timeout: 30_000 }, () => {
  it('renames one', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { finished } = await addPasskey(browser, { name: 'Old name' });

    const renamed = await browser
      .patch(`/api/auth/passkeys/${finished.body.passkey.id}`)
      .send({ name: '  The blue one  ' });

    expect(renamed.body.passkey.name).toBe('The blue one');
    expect((await browser.get('/api/auth/passkeys')).body.passkeys[0].name).toBe('The blue one');
  });

  it('refuses to rename one that belongs to somebody else', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { finished } = await addPasskey(browser);

    const other = request.agent(app);
    await other
      .post('/api/auth/login')
      .send({ identifier: 'owner@example.com', password: PASSWORD });

    const renamed = await request
      .agent(app)
      .patch(`/api/auth/passkeys/${finished.body.passkey.id}`)
      .send({ name: 'mine now' });

    expect(renamed.status).toBe(401);
  });

  it('asks for the password before taking one away', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { finished } = await addPasskey(browser);
    const id = finished.body.passkey.id;

    const refused = await browser.delete(`/api/auth/passkeys/${id}`).send({ password: 'wrong' });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('AUTH_PASSWORD_INCORRECT');

    const removed = await browser.delete(`/api/auth/passkeys/${id}`).send({ password: PASSWORD });
    expect(removed.status).toBe(204);
    expect((await browser.get('/api/auth/passkeys')).body.passkeys).toEqual([]);
  });

  it('has nothing to say about a passkey that is not there', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    const removed = await browser
      .delete('/api/auth/passkeys/00000000-0000-0000-0000-000000000000')
      .send({ password: PASSWORD });

    expect(removed.status).toBe(404);
  });

  it('closes the door on a passkey that is gone', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const { credential, finished } = await addPasskey(browser);
    await browser
      .delete(`/api/auth/passkeys/${finished.body.passkey.id}`)
      .send({ password: PASSWORD });
    await browser.post('/api/auth/logout').send({});

    expect((await signInWith(browser, credential)).status).toBe(401);
  });
});

describe('the site a passkey is bound to', { timeout: 30_000 }, () => {
  it('is the public URL when there is one', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    const started = await browser.post('/api/auth/passkeys/register/start').send({});

    expect(started.body.options.rp.id).toBe('files.example.test');
    expect(started.body.origins).toEqual([PUBLIC_URL]);
  });

  it('is the name the request arrived on when nothing is configured', async () => {
    const { app } = await build({ PUBLIC_URL: undefined });
    const browser = await setUpOwner(app);

    const started = await browser
      .post('/api/auth/passkeys/register/start')
      .set('Host', 'files.lan:3000')
      .send({});

    expect(started.body.options.rp.id).toBe('files.lan');
    expect(started.body.origins).toEqual(['http://files.lan:3000']);
  });

  it('is what the operator settled, over both', async () => {
    const { app } = await build({ WEBAUTHN_RP_ID: 'example.test', WEBAUTHN_RP_NAME: 'Home files' });
    const browser = await setUpOwner(app);

    const started = await browser.post('/api/auth/passkeys/register/start').send({});

    expect(started.body.options.rp).toEqual({ id: 'example.test', name: 'Home files' });
  });

  it('offers passkeys on the sign-in screen where local accounts are offered', async () => {
    const { app } = await build();

    expect((await request(app).get('/api/auth/status')).body.strategies).toMatchObject({
      local: true,
      passkey: true,
    });
  });

  it('offers none when accounts come from the identity provider', async () => {
    const { app } = await build({ AUTH_MODE: 'oidc' });

    const status = await request(app).get('/api/auth/status');
    expect(status.body.strategies.passkey).toBe(false);
    expect((await request(app).post('/api/auth/login/passkey/start').send({})).status).toBe(403);
  });
});
