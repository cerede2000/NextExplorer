import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

let envContext;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'archive-extract-test-',
    modules: [
      'src/services/db',
      'src/services/users',
      'src/services/archiveService',
      'src/utils/pathUtils',
      'src/middleware/errorHandler',
      'src/routes/zip',
    ],
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

const buildApp = ({ user } = {}) => {
  if (!envContext) throw new Error('Test environment not initialized');

  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');

  const zipRoutes = envContext.requireFresh('src/routes/zip');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', zipRoutes);
  app.use(errorHandler);
  return app;
};

const adminUser = { id: 'admin', roles: ['admin'] };

describe('Archive extraction', () => {
  it('extracts a zip archive into a sibling folder', async () => {
    const workDir = path.join(envContext.volumeDir, 'archives');
    await fs.mkdir(workDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile('hello.txt', Buffer.from('hello archive'));
    zip.addFile('nested/deep.txt', Buffer.from('nested content'));
    zip.writeZip(path.join(workDir, 'sample.zip'));

    const app = buildApp({ user: adminUser });
    const response = await request(app)
      .post('/api/files/zip/extract')
      .send({ path: 'archives/sample.zip' });

    expect(response.status).toBe(201);
    expect(response.body.item?.name).toBe('sample');
    expect(response.body.item?.kind).toBe('directory');

    const extractedRoot = path.join(workDir, 'sample');
    expect(await fs.readFile(path.join(extractedRoot, 'hello.txt'), 'utf8')).toBe('hello archive');
    expect(await fs.readFile(path.join(extractedRoot, 'nested', 'deep.txt'), 'utf8')).toBe(
      'nested content'
    );
  });

  it('rejects formats the local build does not support', async () => {
    const workDir = path.join(envContext.volumeDir, 'archives-bad');
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, 'document.docx'), 'not really an archive');

    const app = buildApp({ user: adminUser });
    const response = await request(app)
      .post('/api/files/zip/extract')
      .send({ path: 'archives-bad/document.docx' });

    expect(response.status).toBe(400);
    expect(response.body?.error?.message || response.text).toMatch(/unsupported archive format/i);
  });

  it('reports the supported formats from the 7-Zip probe', async () => {
    const archiveService = envContext.requireFresh('src/services/archiveService');
    const extensions = await archiveService.getSupportedArchiveExtensions();

    expect(Array.isArray(extensions)).toBe(true);
    // zip is always available: either through 7-Zip or the bundled fallback.
    expect(extensions).toContain('zip');
  });
});
