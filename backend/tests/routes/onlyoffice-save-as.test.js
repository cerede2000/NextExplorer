import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * "Save as" hands the backend a URL and a name, both chosen inside an editor
 * running on a different origin. Neither can be taken at face value:
 *
 *  - the URL is fetched by the server, so it is only ever followed when it
 *    points at the configured Document Server. Otherwise this route would fetch
 *    any address an editor asked for;
 *  - the name lands on the filesystem, so it goes through the same validation
 *    as a name typed into the app, and never overwrites an existing file.
 */

describe('ONLYOFFICE save as', () => {
  let env;
  let documentServer;
  let app;
  let filename;
  let port;

  const setup = async () => {
    documentServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.startsWith('/converted')) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end('converted document');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise((resolve, reject) => {
      documentServer.once('error', reject);
      documentServer.listen(0, '127.0.0.1', resolve);
    });
    ({ port } = documentServer.address());

    env = await setupTestEnv({
      tag: 'onlyoffice-save-as-',
      modules: [
        'src/routes/onlyoffice',
        'src/services/accessManager',
        'src/services/folderSizeHooks',
        'src/services/onlyofficeActivityService',
        'src/middleware/errorHandler',
        // These read the configured directories at load time. Left cached, the
        // second test in this file would still be resolving paths against the
        // first one's temporary volume, which by then no longer exists.
        'src/utils/pathUtils',
        'src/utils/fsUtils',
      ],
      env: {
        PUBLIC_URL: 'https://files.example.com',
        ONLYOFFICE_URL: `http://127.0.0.1:${port}`,
        ONLYOFFICE_SECRET: 'onlyoffice-test-secret',
      },
    });

    filename = 'report.docx';
    await fs.writeFile(path.join(env.volumeDir, filename), Buffer.from('original'));

    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    app = createTestApp({
      router: routes,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });
  };

  const saveAs = (body) => request(app).post('/api/onlyoffice/save-as').send(body);

  afterEach(async () => {
    if (documentServer) {
      await new Promise((resolve) => documentServer.close(resolve));
      documentServer = null;
    }
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('writes the converted document beside the original', async () => {
    await setup();

    const response = await saveAs({
      path: filename,
      url: `http://127.0.0.1:${port}/converted.pdf`,
      title: 'report.pdf',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: 'report.pdf', path: 'report.pdf' });
    expect(await fs.readFile(path.join(env.volumeDir, 'report.pdf'), 'utf8')).toBe(
      'converted document'
    );
    // The original is untouched: this saves a copy, it does not move anything.
    expect(await fs.readFile(path.join(env.volumeDir, filename), 'utf8')).toBe('original');
  });

  it('refuses a URL that does not come from the Document Server', async () => {
    await setup();

    const response = await saveAs({
      path: filename,
      url: 'http://169.254.169.254/latest/meta-data/',
      title: 'stolen.pdf',
    });

    expect(response.status).toBe(403);
    await expect(fs.access(path.join(env.volumeDir, 'stolen.pdf'))).rejects.toThrow();
  });

  it('never overwrites an existing file', async () => {
    await setup();
    await fs.writeFile(path.join(env.volumeDir, 'report.pdf'), Buffer.from('do not lose me'));

    const response = await saveAs({
      path: filename,
      url: `http://127.0.0.1:${port}/converted.pdf`,
      title: 'report.pdf',
    });

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('report (1).pdf');
    expect(await fs.readFile(path.join(env.volumeDir, 'report.pdf'), 'utf8')).toBe('do not lose me');
  });

  it('refuses a title that tries to leave the folder', async () => {
    await setup();

    for (const title of ['../escaped.pdf', 'nested/escaped.pdf', '']) {
      const response = await saveAs({
        path: filename,
        url: `http://127.0.0.1:${port}/converted.pdf`,
        title,
      });
      expect(response.status).toBe(400);
    }

    await expect(fs.access(path.join(env.volumeDir, '..', 'escaped.pdf'))).rejects.toThrow();
  });

  it('saves into the folder the document lives in, not the volume root', async () => {
    await setup();
    await fs.mkdir(path.join(env.volumeDir, 'reports'), { recursive: true });
    await fs.writeFile(path.join(env.volumeDir, 'reports', 'q4.docx'), Buffer.from('original'));

    const response = await saveAs({
      path: 'reports/q4.docx',
      url: `http://127.0.0.1:${port}/converted.pdf`,
      title: 'q4.pdf',
    });

    expect(response.status).toBe(200);
    expect(response.body.path).toBe('reports/q4.pdf');
    expect(await fs.readFile(path.join(env.volumeDir, 'reports', 'q4.pdf'), 'utf8')).toBe(
      'converted document'
    );
  });
});
