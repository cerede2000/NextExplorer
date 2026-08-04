import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Creating a blank office document.
 *
 * The point of the route is that the file is openable the moment it exists: a
 * zero-byte `.docx` is not an empty document, it is a file the editor refuses.
 * So what is worth pinning is that real template bytes land on disk, under a
 * name that carries the right extension and belongs to nobody else.
 */

const ZIP_MAGIC = Buffer.from('PK');

describe('new office document', () => {
  let env;
  let app;

  const setup = async () => {
    env = await setupTestEnv({
      tag: 'office-document-',
      modules: [
        'src/routes/files/file',
        'src/services/authorizationService',
        'src/services/folderSizeHooks',
        'src/middleware/errorHandler',
      ],
    });

    await fs.mkdir(path.join(env.volumeDir, 'docs'), { recursive: true });

    const routes = env.requireFresh('src/routes/files/file');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    app = createTestApp({
      router: routes,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });
  };

  const create = (body) => request(app).post('/api/files/office-document').send(body);

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('writes a document an editor can actually open', async () => {
    await setup();

    const response = await create({ path: 'docs', format: 'docx', name: 'Report' });

    expect(response.status).toBe(201);
    expect(response.body.item.name).toBe('Report.docx');

    const written = await fs.readFile(path.join(env.volumeDir, 'docs', 'Report.docx'));
    // Every OOXML file is a zip. Empty or truncated contents are the failure
    // this route exists to avoid, and both are visible right here.
    expect(written.subarray(0, 2)).toEqual(ZIP_MAGIC);
    expect(written.length).toBeGreaterThan(1024);
  });

  it('creates each of the three kinds', async () => {
    await setup();

    for (const [format, expected] of [
      ['docx', 'Document.docx'],
      ['xlsx', 'Spreadsheet.xlsx'],
      ['pptx', 'Presentation.pptx'],
    ]) {
      const response = await create({ path: 'docs', format });
      expect(response.status).toBe(201);
      expect(response.body.item.name).toBe(expected);
    }
  });

  it('keeps a name that already carries the extension', async () => {
    await setup();

    const response = await create({ path: 'docs', format: 'xlsx', name: 'Budget.xlsx' });

    expect(response.body.item.name).toBe('Budget.xlsx');
  });

  it('does not mistake a dotted name for an extension', async () => {
    // "Budget 2026.v2" is a name, not a file with a .v2 extension. Replacing
    // what follows the dot would silently rename the document.
    await setup();

    const response = await create({ path: 'docs', format: 'xlsx', name: 'Budget 2026.v2' });

    expect(response.body.item.name).toBe('Budget 2026.v2.xlsx');
  });

  it('never overwrites a document that is already there', async () => {
    await setup();

    const first = await create({ path: 'docs', format: 'docx', name: 'Report' });
    const second = await create({ path: 'docs', format: 'docx', name: 'Report' });

    expect(first.body.item.name).toBe('Report.docx');
    expect(second.body.item.name).not.toBe('Report.docx');
    expect(second.body.item.name).toMatch(/^Report \d+\.docx$/);
  });

  it('refuses a format it has no template for', async () => {
    await setup();

    const response = await create({ path: 'docs', format: 'exe', name: 'payload' });

    expect(response.status).toBe(400);
  });
});
