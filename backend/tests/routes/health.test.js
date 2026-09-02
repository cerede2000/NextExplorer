import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A liveness probe answers one question: is this process alive and serving
 * HTTP. It was mounted with the rest of the routes, which put it behind the
 * session store, the OpenID Connect middleware and the authorization layer —
 * so it answered a different question, and a container was reported unhealthy
 * for ten minutes while the application it runs served pages perfectly.
 */
const withApp = async (env, run) => {
  const envContext = await setupTestEnv({ tag: 'health-', env });
  try {
    const { createApp } = envContext.requireFresh('src/app');
    await run(await createApp({ skipBootstrap: true, skipStaticFiles: true }));
  } finally {
    await envContext.cleanup();
  }
};

describe('the liveness probe', () => {
  it('answers with authentication required everywhere else', async () => {
    await withApp({ AUTH_MODE: 'local' }, async (app) => {
      // The rest of the API refuses an anonymous caller...
      const refused = await request(app).get('/api/browse');
      expect(refused.status).toBe(401);

      // ...and the probe does not, because it does not ask.
      const health = await request(app).get('/healthz');
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });
    });
  });

  /**
   * The property is the position, so the position is what is asserted. The
   * probe passed the authorization layer either way — it does not begin with
   * `/api`, which that layer lets through — so answering 200 proves nothing
   * about where it sits. What it has to be in front of is the session store
   * and the OpenID Connect middleware, because those are the two that can hold
   * a request open: one talks to a database, the other to an identity
   * provider, and neither has anything to do with whether this container is
   * alive.
   */
  it('answers without creating a session', async () => {
    await withApp({ AUTH_MODE: 'local' }, async (app) => {
      const probe = await request(app).get('/healthz');

      expect(probe.status).toBe(200);
      expect(probe.headers['set-cookie']).toBeUndefined();
    });
  });

  it('answers without a session store or a cookie', async () => {
    await withApp({ AUTH_MODE: 'local' }, async (app) => {
      const response = await request(app).get('/readyz');

      expect(response.status).toBe(200);
      // Nothing was set on the way out: no session was created to answer it.
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });
});

/**
 * The incident this file exists for: the container was reported unhealthy
 * because `/healthz` sat behind the OpenID Connect middleware, which was slow
 * to answer. An identity provider that cannot be reached must not make a
 * running container look dead — that is the whole property, and it is asked of
 * the answer rather than of the router's internals, which changed names in
 * Express 5 and broke the previous version of this test while the application
 * was fine.
 */
describe('a probe with an identity provider that cannot be reached', () => {
  it('still answers', async () => {
    await withApp(
      {
        AUTH_ENABLED: 'true',
        AUTH_MODE: 'oidc',
        OIDC_ENABLED: 'true',
        // Reserved by RFC 6761 for exactly this: it never resolves.
        OIDC_ISSUER: 'https://nothing.invalid',
        OIDC_CLIENT_ID: 'probe-client',
        OIDC_CLIENT_SECRET: 'probe-secret',
      },
      async (app) => {
        const response = await request(app).get('/healthz');

        expect(response.status).toBe(200);
      }
    );
  });
});
