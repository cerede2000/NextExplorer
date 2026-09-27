import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestApp, modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Saving a file and pulling a document from ONLYOFFICE write a hidden temporary
 * beside the file first. A stop half-way left it there for good, out of sight.
 * Each records the temporary before writing it and releases the record once
 * done; this watches the journal while the content is being written — the
 * moment a stop would leave the record behind — and after.
 */

let env;
let documentServer;

afterEach(async () => {
  if (documentServer) {
    await new Promise((resolve) => documentServer.close(resolve));
    documentServer = null;
  }
  if (env) await env.cleanup();
  env = null;
});

const journalOf = () => path.join(env.cacheDir, 'in-flight');

const onDisk = () => {
  const journal = journalOf();
  if (!fs.existsSync(journal)) return [];
  return fs
    .readdirSync(journal)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(journal, name), 'utf8')));
};

describe('saving a file', () => {
  it('records its temporary while writing it, and releases it once the file is saved', async () => {
    env = await setupTestEnv({ tag: 'in-flight-save-', env: { UPLOAD_STORAGE_RESERVE: '0' } });
    await require(modulePath('src/services/db')).getDb();
    const target = path.join(env.volumeDir, 'report.txt');
    fs.writeFileSync(target, 'first');

    let whileWriting = null;
    await require(modulePath('src/services/versions/operations')).saveFile(
      target,
      async (temporary) => {
        whileWriting = { temporary, records: onDisk() };
        fs.writeFileSync(temporary, 'second');
      },
      { source: 'editor' }
    );

    expect(whileWriting.records).toMatchObject([
      { path: whileWriting.temporary, kind: 'temporary-file' },
    ]);
    expect(path.dirname(whileWriting.temporary)).toBe(env.volumeDir);
    expect(fs.readFileSync(target, 'utf8')).toBe('second');
    expect(onDisk()).toEqual([]);
  });

  it('releases its record when the write fails', async () => {
    env = await setupTestEnv({ tag: 'in-flight-save-fail-', env: { UPLOAD_STORAGE_RESERVE: '0' } });
    await require(modulePath('src/services/db')).getDb();
    const target = path.join(env.volumeDir, 'report.txt');
    fs.writeFileSync(target, 'first');

    await expect(
      require(modulePath('src/services/versions/operations')).saveFile(
        target,
        async () => {
          throw new Error('the editor went away');
        },
        { source: 'editor' }
      )
    ).rejects.toThrow('the editor went away');

    expect(fs.readFileSync(target, 'utf8')).toBe('first');
    expect(onDisk()).toEqual([]);
  });
});

describe('saving a new file', () => {
  it('records its temporary while writing it, releases it, and never takes a name already held', async () => {
    env = await setupTestEnv({ tag: 'in-flight-save-new-', env: { UPLOAD_STORAGE_RESERVE: '0' } });
    await require(modulePath('src/services/db')).getDb();
    fs.writeFileSync(path.join(env.volumeDir, 'notes.md'), 'theirs');

    let whileWriting = null;
    const placed = await require(modulePath('src/services/versions/operations')).saveNewFile(
      env.volumeDir,
      'notes.md',
      async (temporary) => {
        whileWriting = { temporary, records: onDisk() };
        fs.writeFileSync(temporary, 'mine');
      },
      { purpose: 'restore' }
    );

    expect(whileWriting.records).toMatchObject([
      { path: whileWriting.temporary, kind: 'temporary-file' },
    ]);
    expect(path.dirname(whileWriting.temporary)).toBe(env.volumeDir);
    expect(placed).toEqual({
      name: 'notes (1).md',
      path: path.join(env.volumeDir, 'notes (1).md'),
    });
    expect(fs.readFileSync(path.join(env.volumeDir, 'notes.md'), 'utf8')).toBe('theirs');
    expect(fs.readFileSync(placed.path, 'utf8')).toBe('mine');
    expect(fs.existsSync(whileWriting.temporary)).toBe(false);
    expect(onDisk()).toEqual([]);
  });

  it('releases its record and leaves no temporary when the write fails', async () => {
    env = await setupTestEnv({
      tag: 'in-flight-save-new-fail-',
      env: { UPLOAD_STORAGE_RESERVE: '0' },
    });
    await require(modulePath('src/services/db')).getDb();

    let temporaryPath = null;
    await expect(
      require(modulePath('src/services/versions/operations')).saveNewFile(
        env.volumeDir,
        'notes.md',
        async (temporary) => {
          temporaryPath = temporary;
          fs.writeFileSync(temporary, 'half');
          throw new Error('the version could not be read');
        }
      )
    ).rejects.toThrow('the version could not be read');

    expect(fs.existsSync(temporaryPath)).toBe(false);
    expect(fs.existsSync(path.join(env.volumeDir, 'notes.md'))).toBe(false);
    expect(onDisk()).toEqual([]);
  });
});

describe('a document pulled from ONLYOFFICE', () => {
  it('records its temporary while it downloads, and releases it once the copy is in place', async () => {
    let whileDownloading = null;
    documentServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.write('converted ');
      // Headers and a first chunk are out: the temporary is being written.
      setTimeout(() => {
        whileDownloading = onDisk();
        res.end('document');
      }, 50);
    });
    await new Promise((resolve, reject) => {
      documentServer.once('error', reject);
      documentServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = documentServer.address();

    env = await setupTestEnv({
      tag: 'in-flight-onlyoffice-',
      modules: ['src/routes/onlyoffice', 'src/middleware/errorHandler'],
      env: {
        PUBLIC_URL: 'https://files.example.com',
        ONLYOFFICE_URL: `http://127.0.0.1:${port}`,
        ONLYOFFICE_SECRET: 'onlyoffice-test-secret',
      },
    });
    fs.writeFileSync(path.join(env.volumeDir, 'report.docx'), 'original');
    const app = createTestApp({
      router: env.requireFresh('src/routes/onlyoffice'),
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler: env.requireFresh('src/middleware/errorHandler').errorHandler,
    });

    const response = await request(app)
      .post('/api/onlyoffice/save-as')
      .send({
        path: 'report.docx',
        url: `http://127.0.0.1:${port}/converted.pdf`,
        title: 'report.pdf',
      });

    expect(response.status).toBe(200);
    expect(whileDownloading).toHaveLength(1);
    expect(whileDownloading[0].kind).toBe('temporary-file');
    expect(path.dirname(whileDownloading[0].path)).toBe(env.volumeDir);
    expect(path.basename(whileDownloading[0].path)).toMatch(/^\.report\.pdf\.onlyoffice-.+\.tmp$/);
    expect(fs.readFileSync(path.join(env.volumeDir, 'report.pdf'), 'utf8')).toBe(
      'converted document'
    );
    expect(onDisk()).toEqual([]);
  });
});
