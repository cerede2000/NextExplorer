import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The authentication gate, asked in every spelling Express answers to.
 *
 * Express matches routes without regard to case, so `/API/volumes` is the same
 * route as `/api/volumes`. The gate compared the path as it arrived, answered
 * "this is not an API route" to anything not spelled `/api`, and let the
 * request through with no identity: measured on the image, `/API/volumes` and
 * `/API/settings` answered 200 to nobody. Whatever the spelling, a route that
 * needs somebody has to refuse nobody the same way.
 *
 * Built from the real application, so the gate is asked in front of the routes
 * it actually guards and not a stand-in for them.
 */

let envContext;
let app;

beforeAll(async () => {
  envContext = await setupTestEnv({ tag: 'auth-gate-spelling-', env: { AUTH_ENABLED: 'true' } });
  const { createApp } = envContext.requireFresh('src/app');
  app = await createApp({ skipOidc: true, skipStaticFiles: true });
}, 30000);

afterAll(async () => {
  await envContext?.cleanup();
});

describe('a route that needs somebody, asked by nobody', () => {
  it.each([
    ['/api/volumes'],
    ['/API/volumes'],
    ['/Api/Volumes'],
    ['/api/VOLUMES'],
    ['/API/settings'],
    ['/aPi/users'],
    ['/API/browse/'],
  ])('is refused when spelled %s', async (spelling) => {
    const response = await request(app).get(spelling);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Authentication required.' });
  });
});

describe('a route that needs nobody', () => {
  // The control for the refusals above: the gate still lets through what it
  // is meant to, in whatever case it arrives.
  it.each([['/api/features'], ['/API/features'], ['/api/auth/status'], ['/API/AUTH/status']])(
    'still answers when spelled %s',
    async (spelling) => {
      const response = await request(app).get(spelling);

      expect(response.status).toBe(200);
    }
  );
});
