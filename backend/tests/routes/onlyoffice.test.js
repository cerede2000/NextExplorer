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
  let app;

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

  it('queues signed close and live force-saves without blocking the preview', async () => {
    let commandPayload = null;
    let commandRequestUrl = null;
    let callbackPath = null;
    let callbackToken = null;
    const commandPayloads = [];
    const callbackPromises = [];
    let resolveCommand;
    let resolveSecondCommand;
    let releaseFirstCallback;
    const commandReceived = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    const secondCommandReceived = new Promise((resolve) => {
      resolveSecondCommand = resolve;
    });
    const firstCallbackReleased = new Promise((resolve) => {
      releaseFirstCallback = resolve;
    });
    commandServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/saved.docx') {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end('updated');
        return;
      }
      if (req.method === 'GET' && req.url === '/broken.docx') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '1024',
        });
        res.write('partial');
        setTimeout(() => res.destroy(), 10);
        return;
      }

      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        commandRequestUrl = req.url;
        commandPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        commandPayloads.push(commandPayload);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 0 }));

        const callback = () =>
          request(app)
            .post(callbackPath)
            .set('Authorization', `Bearer ${callbackToken}`)
            .send({
              status: 6,
              key: commandPayload.key,
              forcesavetype: 0,
              userdata: commandPayload.userdata,
              url: `http://127.0.0.1:${port}/saved.docx`,
            })
            .then((response) => response);
        const callbackPromise =
          commandPayloads.length === 1 ? firstCallbackReleased.then(callback) : callback();
        callbackPromises.push(callbackPromise);
        if (commandPayloads.length === 1) resolveCommand();
        else resolveSecondCommand();
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
        ONLYOFFICE_FORCE_SAVE_TIMEOUT_MS: '20',
        ONLYOFFICE_AUTO_SAVE_INTERVAL_MS: '30000',
      },
    });

    const filename = 'report.docx';
    await fs.writeFile(path.join(env.volumeDir, filename), Buffer.from('original'));

    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    app = createTestApp({
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
    expect(configResponse.body.forceSaveSessionId).toEqual(expect.any(String));
    expect(configResponse.body.autoSaveIntervalMs).toBe(30000);
    callbackPath = `${new URL(configResponse.body.config.editorConfig.callbackUrl).pathname}${
      new URL(configResponse.body.config.editorConfig.callbackUrl).search
    }`;
    callbackToken = configResponse.body.config.token;

    const heartbeatResponse = await request(app).post('/api/onlyoffice/session-heartbeat').send({
      path: filename,
      sessionId: configResponse.body.forceSaveSessionId,
    });
    expect(heartbeatResponse.status).toBe(200);
    expect(heartbeatResponse.body).toEqual({ active: true });

    const forceSaveResponse = await request(app)
      .post('/api/onlyoffice/force-save')
      .send({ path: filename, sessionId: configResponse.body.forceSaveSessionId, reason: 'auto' });

    expect(forceSaveResponse.status).toBe(202);
    expect(forceSaveResponse.body).toMatchObject({ queued: true, requestId: expect.any(String) });
    await commandReceived;
    expect(commandPayload).toMatchObject({ c: 'forcesave' });
    expect(new URL(commandRequestUrl, `http://127.0.0.1:${port}`).pathname).toBe('/command');
    expect(
      new URL(commandRequestUrl, `http://127.0.0.1:${port}`).searchParams.get('shardkey')
    ).toBe(commandPayload.key);
    expect(commandPayload.userdata).toMatch(/^nextexplorer-force-save:/);
    expect(jwt.verify(commandPayload.token, 'onlyoffice-test-secret')).toMatchObject({
      c: 'forcesave',
      key: commandPayload.key,
      userdata: commandPayload.userdata,
    });

    const closeForceSaveResponse = await request(app)
      .post('/api/onlyoffice/force-save')
      .send({ path: filename, sessionId: configResponse.body.forceSaveSessionId });
    expect(closeForceSaveResponse.status).toBe(202);
    expect(closeForceSaveResponse.body).toMatchObject({
      queued: true,
      requestId: forceSaveResponse.body.requestId,
      coalesced: true,
      followUp: true,
    });

    releaseFirstCallback();
    expect((await callbackPromises[0]).body).toEqual({ error: 0 });
    expect(await fs.readFile(path.join(env.volumeDir, filename), 'utf8')).toBe('updated');
    await secondCommandReceived;
    expect(commandPayloads[1].key).toBe(configResponse.body.config.document.key);
    expect((await callbackPromises[1]).body).toEqual({ error: 0 });

    const failedCallback = await request(app)
      .post(callbackPath)
      .set('Authorization', `Bearer ${callbackToken}`)
      .send({
        status: 6,
        key: commandPayload.key,
        url: `http://127.0.0.1:${port}/broken.docx`,
      });
    expect(failedCallback.body).toEqual({ error: 1 });
    expect(await fs.readFile(path.join(env.volumeDir, filename), 'utf8')).toBe('updated');

    const closeResponse = await request(app).post('/api/onlyoffice/session-close').send({
      path: filename,
      sessionId: configResponse.body.forceSaveSessionId,
    });
    expect(closeResponse.status).toBe(204);

    const expiredHeartbeatResponse = await request(app)
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: filename, sessionId: configResponse.body.forceSaveSessionId });
    expect(expiredHeartbeatResponse.status).toBe(403);
  });
});
