import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

describe('Baseline security headers', () => {
  it('sets them on every response and hides the framework banner', async () => {
    const env = await setupTestEnv({
      tag: 'security-headers-',
      modules: ['src/config/env', 'src/config/index', 'src/middleware/securityHeaders'],
    });
    try {
      const { configureSecurityHeaders } = env.requireFresh('src/middleware/securityHeaders');
      const app = express();
      configureSecurityHeaders(app);
      app.get('/anything', (_req, res) => res.json({ ok: true }));

      const response = await request(app).get('/anything');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['referrer-policy']).toBe('same-origin');
      expect(response.headers['permissions-policy']).toContain('camera=()');
      expect(response.headers['x-powered-by']).toBeUndefined();
    } finally {
      await env.cleanup();
    }
  });

  it('leaves a stricter header set by a route untouched', async () => {
    const env = await setupTestEnv({
      tag: 'security-headers-override-',
      modules: ['src/config/env', 'src/config/index', 'src/middleware/securityHeaders'],
    });
    try {
      const { configureSecurityHeaders } = env.requireFresh('src/middleware/securityHeaders');
      const app = express();
      configureSecurityHeaders(app);
      app.get('/embedded', (_req, res) => {
        res.setHeader('X-Frame-Options', 'DENY');
        res.json({ ok: true });
      });

      const response = await request(app).get('/embedded');
      expect(response.headers['x-frame-options']).toBe('DENY');
    } finally {
      await env.cleanup();
    }
  });
});

describe('Client error messages', () => {
  it('does not disclose server-side absolute paths', async () => {
    const env = await setupTestEnv({
      tag: 'error-paths-',
      modules: ['src/config/env', 'src/config/index', 'src/middleware/errorHandler'],
    });
    try {
      const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
      const app = express();
      app.get('/boom', (_req, _res, next) => {
        // Shape of a real fs failure bubbling up from a nested service.
        next(
          Object.assign(
            new Error(`ENOENT: no such file or directory, stat '${env.volumeDir}/secret/report.pdf'`),
            { statusCode: 404, isOperational: true }
          )
        );
      });
      app.use(errorHandler);

      const response = await request(app).get('/boom');

      expect(response.status).toBe(404);
      expect(response.body.error.message).not.toContain(env.volumeDir);
      expect(response.body.error.message).toContain('report.pdf');
    } finally {
      await env.cleanup();
    }
  });
});
