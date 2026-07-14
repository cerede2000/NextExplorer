import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

describe('ONLYOFFICE routes', () => {
  let env;
  let commandServer;

  afterEach(async () => {
    if (commandServer) {
      await new Promise((resolve, reject) => {
        commandServer.close((error) => (error ? reject(error) : resolve()));
      });
      commandServer = null;
    }
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('enables Save force-save and queues a signed close force-save command', async () => {
    let commandPayload = null;
    commandServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        commandPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 0 }));
      });
    });
    await new Promise((resolve, reject) => {
      commandServer.once('error', reject);
      commandServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = commandServer.address();

    env = await setupTestEnv({
      tag: 'onlyoffice-route-',
      modules: [
        'src/routes/onlyoffice',
        'src/services/accessManager',
        'src/services/folderSizeHooks',
        'src/middleware/errorHandler',
      ],
      env: {
        PUBLIC_URL: 'https://files.example.com',
        ONLYOFFICE_URL: `http://127.0.0.1:${port}`,
        ONLYOFFICE_SECRET: 'onlyoffice-test-secret',
        ONLYOFFICE_FORCE_SAVE: 'true',
      },
    });

    const filename = 'report.docx';
    await fs.writeFile(path.join(env.volumeDir, filename), Buffer.from('original'));

    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    const app = createTestApp({
      router: routes,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });

    const configResponse = await request(app)
      .post('/api/onlyoffice/config')
      .send({ path: filename });

    expect(configResponse.status).toBe(200);
    expect(configResponse.body.config.editorConfig.customization.forcesave).toBe(true);

    const forceSaveResponse = await request(app)
      .post('/api/onlyoffice/force-save')
      .send({ path: filename });

    expect(forceSaveResponse.status).toBe(200);
    expect(forceSaveResponse.body).toEqual({ queued: true });
    expect(commandPayload).toMatchObject({ c: 'forcesave' });
    expect(jwt.verify(commandPayload.token, 'onlyoffice-test-secret')).toMatchObject({
      c: 'forcesave',
      key: commandPayload.key,
    });
  });
});
