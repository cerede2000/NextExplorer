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
describe('the liveness probe', () => {
  const withApp = async (env, run) => {
    const envContext = await setupTestEnv({ tag: 'health-', env });
    try {
      const { createApp } = envContext.requireFresh('src/app');
      await run(await createApp({ skipBootstrap: true, skipStaticFiles: true }));
    } finally {
      await envContext.cleanup();
    }
  };

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
  it('is registered before anything that talks to a database or the network', async () => {
    await withApp({ AUTH_MODE: 'local' }, async (app) => {
      const stack = app._router.stack;
      const healthAt = stack.findIndex((layer) =>
        layer.handle?.stack?.some((inner) => inner.route?.path === '/healthz')
      );
      const sessionAt = stack.findIndex((layer) => layer.name === 'session');

      expect(healthAt).toBeGreaterThanOrEqual(0);
      expect(sessionAt).toBeGreaterThanOrEqual(0);
      expect(healthAt).toBeLessThan(sessionAt);
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
