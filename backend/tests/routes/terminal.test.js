import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { setupTestEnv, createTestApp } from '../helpers/env-test-utils.js';

let envContext;

const adminUser = {
  id: 'admin-user',
  username: 'admin',
  roles: ['admin'],
};

const buildApp = () => {
  const terminalService = envContext.requireFresh('src/services/terminalService');
  terminalService.enabled = true;
  terminalService.available = true;

  const terminalRoutes = envContext.requireFresh('src/routes/terminal');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  return {
    app: createTestApp({
      router: terminalRoutes,
      mountPath: '/api',
      user: adminUser,
      errorHandler,
    }),
    terminalService,
  };
};

beforeEach(async () => {
  envContext = await setupTestEnv({
    tag: 'terminal-routes-test-',
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/terminal',
      'src/services/accessManager',
      'src/services/terminalService',
      'src/utils/pathUtils',
    ],
  });
});

afterEach(async () => {
  await envContext.cleanup();
});

describe('Terminal Routes', () => {
  it('stores the resolved current folder as the terminal session cwd', async () => {
    const targetDir = path.join(envContext.volumeDir, 'Projects', 'NextExplorer');
    await fs.mkdir(targetDir, { recursive: true });

    const { app, terminalService } = buildApp();
    const server = app.listen(0);

    try {
      const response = await request(server)
        .post('/api/terminal/session')
        .send({ cwd: 'Projects/NextExplorer' });

      expect(response.status).toBe(200);
      expect(response.body.token).toBeTruthy();

      const session = terminalService.validateSessionToken(response.body.token);
      expect(session.cwd).toBe(targetDir);
    } finally {
      server.close();
    }
  });
});
