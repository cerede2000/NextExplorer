import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import request from 'supertest';
import { setupTestEnv, createTestApp } from '../helpers/env-test-utils.js';

describe('Usage Routes', () => {
  let env;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('returns filesystem usage for an accessible volume path', async () => {
    env = await setupTestEnv({
      tag: 'usage-route-',
      modules: ['src/routes/usage', 'src/services/accessManager', 'src/utils/pathUtils'],
    });

    await fs.mkdir(`${env.volumeDir}/TestVol`);

    const usageRoutes = env.requireFresh('src/routes/usage');
    const app = createTestApp({
      router: usageRoutes,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
    });

    const response = await request(app).get('/api/usage/TestVol');

    expect(response.status).toBe(200);
    expect(response.body.path).toBe('TestVol');
    expect(response.body.total).toBeGreaterThan(0);
    expect(response.body.free).toBeGreaterThanOrEqual(0);
    expect(response.body.used).toBeGreaterThanOrEqual(0);
    expect(response.body.size).toBe(response.body.used);
    expect(response.body.percentUsed).toBeGreaterThanOrEqual(0);
    expect(response.body.percentUsed).toBeLessThanOrEqual(100);
  });
});
