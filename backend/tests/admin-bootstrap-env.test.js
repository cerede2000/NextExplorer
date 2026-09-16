import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from './helpers/env-test-utils.js';

/**
 * A whole-file budget, against a vitest default of five seconds.
 *
 * Every test here hashes a password with bcrypt at cost twelve, twice over for
 * the bootstrap that replaces one, and the suite runs a worker per core: on a
 * contended machine that is not slow work, it is queued work. Sized for an idle
 * machine, it fails on the scheduler rather than on anything this file checks —
 * which is what it did here, with three suites running at once.
 */
vi.setConfig({ testTimeout: 30_000 });

describe('Admin Bootstrap from Environment', () => {
  let envContext;

  beforeAll(async () => {
    envContext = await setupTestEnv({
      tag: 'admin-bootstrap-env-',
      modules: ['src/services/db', 'src/services/users', 'src/utils/bootstrap', 'src/routes/auth'],
      env: {
        AUTH_ENABLED: 'true',
        AUTH_MODE: 'local',
        AUTH_ADMIN_EMAIL: 'admin@example.com',
        AUTH_ADMIN_PASSWORD: 'secret123',
      },
    });
  });

  afterAll(async () => {
    await envContext.cleanup();
  });

  const buildApp = () => {
    const authRoutes = envContext.requireFresh('src/routes/auth');
    const app = express();
    app.use(express.json());
    app.use(
      session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
      })
    );

    // Minimal stub for req.oidc so /status works without EOC
    app.use((req, _res, next) => {
      req.oidc = { isAuthenticated: () => false };
      next();
    });

    app.use('/api/auth', authRoutes);
    app.use((err, _req, res) => {
      res.status(err.status || 500).json({ error: err.message });
    });
    return app;
  };

  const requireFreshBootstrap = () => {
    clearModuleCache('src/config/env');
    clearModuleCache('src/config/index');
    clearModuleCache('src/services/users');
    clearModuleCache('src/utils/bootstrap');
    return envContext.requireFresh('src/utils/bootstrap');
  };

  describe('Initial Bootstrap', () => {
    it('should create admin and skip setup when env vars are provided', async () => {
      const { bootstrap } = requireFreshBootstrap();
      await bootstrap();

      const app = buildApp();
      const status = await request(app).get('/api/auth/status');

      expect(status.status).toBe(200);
      expect(status.body.requiresSetup).toBe(false);

      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@example.com', password: 'secret123' });

      expect(loginResponse.status).toBe(200);
    });
  });

  describe('Password Override', () => {
    it('should override existing password on subsequent bootstrap', async () => {
      // Override password env var
      process.env.AUTH_ADMIN_PASSWORD = 'newpass456';

      const { bootstrap } = requireFreshBootstrap();
      await bootstrap();

      const users = envContext.requireFresh('src/services/users');
      const ok = await users.attemptLocalLogin({
        email: 'admin@example.com',
        password: 'newpass456',
      });
      expect(ok).toBeDefined();

      const old = await users.attemptLocalLogin({
        email: 'admin@example.com',
        password: 'secret123',
      });
      expect(old).toBeNull();
    });
  });
});
