import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import { createTestApp, modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * One box on the sign-in screen, and the same name for it all the way down.
 *
 * The box takes an email address or a username, so it is neither: it is
 * whatever was typed. That name has to hold from the screen to the route, and
 * when it did not, nothing said so. The screen sent `identifier`, the store
 * passed on `email`, and `JSON.stringify` drops a key whose value is undefined
 * — so the request went out carrying a password and nobody to sign in, and the
 * answer was "invalid credentials", which is what a wrong password looks like.
 *
 * Both halves are asserted here: the route takes the name the screen sends, and
 * the screen, the client and the store all use that one name. The second half
 * is read off the frontend sources, because the chain is four files long and
 * three of them have no runner here — and a chain that breaks silently in the
 * middle is exactly what this is for.
 */

const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend', 'src');
const read = (relative) => fs.readFileSync(path.join(FRONTEND, relative), 'utf8');

describe('the name for what was typed into the sign-in box', () => {
  let env;
  let app;

  beforeEach(async () => {
    env = await setupTestEnv({
      tag: 'sign-in-identifier-',
      modules: ['src/services/db', 'src/routes/auth', 'src/middleware/errorHandler'],
      envOverrides: { AUTH_ENABLED: 'true' },
    });
    await env.requireFresh('src/services/users').createLocalUser({
      email: 'alice@example.com',
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery',
      roles: ['admin'],
    });
    app = createTestApp({
      router: env.requireFresh('src/routes/auth'),
      mountPath: '/api/auth',
      errorHandler: env.requireFresh('src/middleware/errorHandler').errorHandler,
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const signIn = (body) => request(app).post('/api/auth/login').send(body);

  it('signs in with the name the screen sends', async () => {
    const response = await signIn({
      identifier: 'alice@example.com',
      password: 'correct horse battery',
    });

    expect(response.status).toBe(200);
    expect(response.body.user?.email).toBe('alice@example.com');
  });

  it('takes a username in the same box', async () => {
    const response = await signIn({ identifier: 'alice', password: 'correct horse battery' });

    expect(response.status).toBe(200);
    expect(response.body.user?.username).toBe('alice');
  });

  it.each(['email', 'username'])('still takes the older name %s', async (name) => {
    const response = await signIn({
      [name]: name === 'email' ? 'alice@example.com' : 'alice',
      password: 'correct horse battery',
    });

    expect(response.status).toBe(200);
  });

  it('refuses a password that is wrong, and says nothing about which half', async () => {
    const response = await signIn({ identifier: 'alice', password: 'not it' });

    expect(response.status).toBe(401);
    expect(response.body.error?.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  /**
   * The screen, the client and the store. A rename that stops at one of them
   * leaves the next passing undefined, which is not an error anywhere — the key
   * simply vanishes from the request body.
   */
  it('is the name the screen, the client and the store all use', () => {
    expect(read('views/AuthLoginView.vue')).toMatch(/auth\.login\(\{\s*identifier:/);
    expect(read('api/auth.api.js')).toMatch(/const login = \(\{ identifier, password \}\)/);
    expect(read('stores/auth.js')).toMatch(/const login = async \(\{ identifier, password \}\)/);
    expect(read('stores/auth.js')).toMatch(/loginApi\(\{ identifier, password \}\)/);
  });

  /**
   * Everything else the sign-in screen reads off the store.
   *
   * The same rename went through this screen and stopped before the store, and
   * the identifier was only the half that failed loudly. `totpPending` reads
   * undefined, so the box for the code from the authenticator never appears:
   * a correct password on an account with a second factor lands on a screen
   * that looks like it did nothing. Undefined is not an error in a template —
   * it is a `v-if` that is false — so there is nothing to see but the absence.
   */
  it.each(['totpPending', 'oidcStatus', 'cancelTotp', 'ensureStatus', 'forgetSession'])(
    'is on the store, because the screen reads it: %s',
    (member) => {
      expect(read('stores/auth.js')).toContain(member);
    }
  );
});
