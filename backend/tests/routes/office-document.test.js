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

  it('creates the text formats empty, which is what makes them valid', async () => {
    // A .txt with nothing in it is a .txt. Giving these a template would be
    // inventing content nobody asked for.
    await setup();

    for (const [format, expected] of [
      ['txt', 'Document.txt'],
      ['md', 'Document.md'],
      ['csv', 'Data.csv'],
    ]) {
      const response = await create({ path: 'docs', format });
      expect(response.status).toBe(201);
      expect(response.body.item.name).toBe(expected);

      const written = await fs.readFile(path.join(env.volumeDir, 'docs', expected));
      expect(written.length).toBe(0);
    }
  });

  it('creates a PDF from a real template, not an empty file', async () => {
    await setup();

    const response = await create({ path: 'docs', format: 'pdf', name: 'Form' });

    expect(response.status).toBe(201);
    const written = await fs.readFile(path.join(env.volumeDir, 'docs', 'Form.pdf'));
    expect(written.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('refuses a format it has no template for', async () => {
    await setup();

    const response = await create({ path: 'docs', format: 'exe', name: 'payload' });

    expect(response.status).toBe(400);
  });
});

/**
 * The extension the caller chooses.
 *
 * The three text formats on the menu were three of the fifty the text editor
 * opens, so a `.json`, a `.yml` or a `.sh` had to be made as something else and
 * renamed. An empty file is an empty file whatever it is called, so where there
 * is no template the extension is the caller's — and where there is one it
 * cannot be, because the bytes are what decide whether an editor will open the
 * file at all.
 */
describe('a chosen extension', () => {
  let env;
  let app;

  const setup = async () => {
    env = await setupTestEnv({
      tag: 'office-document-extension-',
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

  it('gives a text document the extension that was asked for', async () => {
    await setup();

    for (const [extension, expected] of [
      ['json', 'settings.json'],
      ['yml', 'settings.yml'],
      ['sh', 'settings.sh'],
      ['tar.gz', 'settings.tar.gz'],
    ]) {
      const response = await create({
        path: 'docs',
        format: 'txt',
        name: 'settings',
        extension,
      });

      expect(response.status).toBe(201);
      expect(response.body.item.name).toBe(expected);
      const written = await fs.readFile(path.join(env.volumeDir, 'docs', expected));
      expect(written.length).toBe(0);
    }
  });

  it('keeps the case the extension was typed in, and does not say it twice', async () => {
    await setup();

    const asked = await create({ path: 'docs', format: 'txt', name: 'query', extension: '.SQL' });
    expect(asked.body.item.name).toBe('query.SQL');

    // The name already ends in it, whatever the case: adding it again would
    // make `report.SQL.sql`.
    const already = await create({
      path: 'docs',
      format: 'txt',
      name: 'report.SQL',
      extension: 'sql',
    });
    expect(already.body.item.name).toBe('report.SQL');
  });

  it('names the document after the extension when no name was given', async () => {
    await setup();

    const response = await create({ path: 'docs', format: 'txt', extension: 'json' });

    expect(response.body.item.name).toBe('Document.json');
  });

  it('makes a file with no extension at all when the extension is empty', async () => {
    // Which is how `Dockerfile` is asked for.
    await setup();

    const response = await create({
      path: 'docs',
      format: 'txt',
      name: 'Dockerfile',
      extension: '',
    });

    expect(response.status).toBe(201);
    expect(response.body.item.name).toBe('Dockerfile');
    expect((await fs.readFile(path.join(env.volumeDir, 'docs', 'Dockerfile'))).length).toBe(0);
  });

  it('refuses an extension on a format made from a template', async () => {
    // The bytes are an OOXML package. A name that disagrees with them is a file
    // no editor opens, which is the whole reason this route exists.
    await setup();

    for (const format of ['docx', 'xlsx', 'pptx', 'pdf']) {
      const response = await create({ path: 'docs', format, name: 'Report', extension: 'txt' });
      expect(response.status).toBe(400);
    }

    // Asking for the one it already has is not a change, and is allowed.
    const same = await create({ path: 'docs', format: 'docx', name: 'Report', extension: 'docx' });
    expect(same.status).toBe(201);
    expect(same.body.item.name).toBe('Report.docx');
  });

  it('refuses an extension that is not one', async () => {
    await setup();

    for (const extension of [
      '../escape',
      'a/b',
      'a\\b',
      'two words',
      'no-ending-',
      'x'.repeat(21),
      'ht\u0000ml',
    ]) {
      const response = await create({ path: 'docs', format: 'txt', name: 'probe', extension });
      expect(response.status, `extension ${JSON.stringify(extension)}`).toBe(400);
    }
  });

  it('still never overwrites, whatever the extension', async () => {
    await setup();

    const first = await create({ path: 'docs', format: 'txt', name: 'notes', extension: 'json' });
    const second = await create({ path: 'docs', format: 'txt', name: 'notes', extension: 'json' });

    expect(first.body.item.name).toBe('notes.json');
    expect(second.body.item.name).not.toBe('notes.json');
    expect(second.body.item.name).toMatch(/^notes \d+\.json$/);
  });
});
