import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The ONLYOFFICE callback is exempt from authentication: the Document Server
 * calls it directly. It trusts a backend token we signed instead of resolving
 * permissions again, so that token has to carry the write decision, and the
 * URL it is asked to download from has to belong to the Document Server.
 */

const SECRET = 'test-onlyoffice-secret';
const DOCUMENT_SERVER = 'https://documentserver.example.com';

const createContext = async (tag, extraEnv = {}) => {
  const env = await setupTestEnv({
    tag,
    modules: [
      'src/config/env',
      'src/config/index',
      'src/utils/pathUtils',
      'src/routes/onlyoffice',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/services/settingsService',
    ],
    env: {
      ONLYOFFICE_URL: DOCUMENT_SERVER,
      ONLYOFFICE_SECRET: SECRET,
      PUBLIC_URL: 'https://files.example.com',
      ...extraEnv,
    },
  });

  const onlyofficeRoutes = env.requireFresh('src/routes/onlyoffice');
  const { errorHandler } = env.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use('/api', onlyofficeRoutes);
  app.use(errorHandler);

  return { env, app };
};

const signBackendToken = (payload) =>
  jwt.sign({ typ: 'nextexplorer-backend', ...payload }, SECRET, { algorithm: 'HS256' });

/** Stand-in Document Server that serves the "saved" document. */
const startDocumentServer = async (body) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/cache/files/edited.docx`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

describe('ONLYOFFICE callback security', () => {
  it('saves the document when the session was allowed to write, and only then', async () => {
    const documentServer = await startDocumentServer('edited content');
    const { env, app } = await createContext('onlyoffice-write-', {
      ONLYOFFICE_DOWNLOAD_ORIGINS: documentServer.origin,
    });
    try {
      const writable = path.join(env.volumeDir, 'writable.docx');
      const readonly = path.join(env.volumeDir, 'readonly.docx');
      await fs.writeFile(writable, 'original');
      await fs.writeFile(readonly, 'original');

      const dsToken = jwt.sign({ status: 2 }, SECRET, { algorithm: 'HS256' });

      // Baseline: an editing session that was allowed to write saves.
      const allowed = await request(app)
        .post('/api/onlyoffice/callback')
        .query({
          path: 'writable.docx',
          backend: signBackendToken({ absolutePath: writable, canWrite: true }),
        })
        .set('Authorization', `Bearer ${dsToken}`)
        .send({ status: 2, url: documentServer.url });

      expect(allowed.body.error).toBe(0);
      await expect(fs.readFile(writable, 'utf-8')).resolves.toBe('edited content');

      // Same request, same reachable URL: only the write flag differs.
      const denied = await request(app)
        .post('/api/onlyoffice/callback')
        .query({
          path: 'readonly.docx',
          backend: signBackendToken({ absolutePath: readonly, canWrite: false }),
        })
        .set('Authorization', `Bearer ${dsToken}`)
        .send({ status: 2, url: documentServer.url });

      // The callback contract answers 200 with a non-zero error code.
      expect(denied.body.error).toBe(1);
      await expect(fs.readFile(readonly, 'utf-8')).resolves.toBe('original');
    } finally {
      await env.cleanup();
      await documentServer.close();
    }
  });

  it('refuses a document URL that does not come from the Document Server', async () => {
    const { env, app } = await createContext('onlyoffice-ssrf-');
    try {
      const target = path.join(env.volumeDir, 'writable.docx');
      await fs.writeFile(target, 'original');

      const backend = signBackendToken({ absolutePath: target, canWrite: true });
      const dsToken = jwt.sign({ status: 2 }, SECRET, { algorithm: 'HS256' });

      const response = await request(app)
        .post('/api/onlyoffice/callback')
        .query({ path: 'writable.docx', backend })
        .set('Authorization', `Bearer ${dsToken}`)
        .send({ status: 2, url: 'http://169.254.169.254/latest/meta-data/' });

      expect(response.body.error).toBe(1);
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('original');
    } finally {
      await env.cleanup();
    }
  });

  it('ignores a Document Server token replayed as a backend token', async () => {
    const { env, app } = await createContext('onlyoffice-token-type-');
    try {
      const target = path.join(env.volumeDir, 'typed.docx');
      await fs.writeFile(target, 'original');

      // Same secret, no type claim: this must not be accepted as a backend
      // context, otherwise any signed payload could name a path to overwrite.
      const forged = jwt.sign({ absolutePath: target, canWrite: true }, SECRET, {
        algorithm: 'HS256',
      });
      const dsToken = jwt.sign({ status: 2 }, SECRET, { algorithm: 'HS256' });

      const response = await request(app)
        .post('/api/onlyoffice/callback')
        .query({ path: 'typed.docx', backend: forged })
        .set('Authorization', `Bearer ${dsToken}`)
        .send({ status: 2, url: `${DOCUMENT_SERVER}/cache/files/edited.docx` });

      // Falls back to a real permission check, which fails without a user.
      expect(response.body.error).toBe(1);
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('original');
    } finally {
      await env.cleanup();
    }
  });

  it('accepts an extra download origin when it is configured', async () => {
    const env = await setupTestEnv({
      tag: 'onlyoffice-origins-',
      modules: ['src/config/env', 'src/config/index'],
      env: {
        ONLYOFFICE_URL: DOCUMENT_SERVER,
        ONLYOFFICE_SECRET: SECRET,
        ONLYOFFICE_DOWNLOAD_ORIGINS: 'http://onlyoffice-internal:80, https://ds.lan',
      },
    });
    try {
      const { onlyoffice } = env.requireFresh('src/config/index');
      expect(onlyoffice.downloadOrigins).toEqual([
        'http://onlyoffice-internal',
        'https://ds.lan',
      ]);
    } finally {
      await env.cleanup();
    }
  });
});
