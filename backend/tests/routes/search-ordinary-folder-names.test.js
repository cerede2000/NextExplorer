import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Folder names an editor skips and a file server must not.
 *
 * Search carried `.git`, `node_modules`, `dist` and `build` as names to walk
 * past — a habit that belongs in a code editor. Here they are folder names
 * somebody may have put a year of work in, and a file under one of them could
 * not be found by name or by content, with nothing in the answer to say why
 * (#11).
 *
 * Both engines are exercised, because the names were hard-coded twice: once as
 * ripgrep globs and once in the walker that runs when ripgrep is absent.
 */

let envContext;

const buildApp = () => {
  const searchRoutes = envContext.requireFresh('src/routes/search');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'u1', email: 'u@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', searchRoutes);
  app.use(errorHandler);
  return app;
};

const seed = async (env = {}) => {
  envContext = await setupTestEnv({
    tag: 'search-folder-names-',
    env: { SEARCH_RIPGREP: 'true', SEARCH_DEEP: 'true', ...env },
  });
  const dbService = envContext.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1', 'u@example.com', 1, 'u', 'U', '["admin"]', ?, ?)`
  ).run(now, now);
  return path.join(envContext.volumeDir, 'Docs');
};

const search = async (term) => {
  const response = await request(buildApp()).get('/api/search').query({ q: term });
  expect(response.status).toBe(200);
  return (response.body.items || []).map((item) => `${item.path}/${item.name}`);
};

/** One file at `relDir/name`, and what searching for `term` returns. */
const withFile = async ({ relDir, name, contents = 'nothing in particular', term, env }) => {
  const docs = await seed(env);
  const dir = path.join(docs, relDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), contents);
  return search(term);
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('a folder named like a build directory', () => {
  for (const folder of ['build', 'dist', 'node_modules']) {
    it(`finds a file by name under ${folder}`, async () => {
      const found = await withFile({
        relDir: `projects/${folder}/reports`,
        name: 'quarterly.txt',
        term: 'quarterly',
      });
      expect(found).toContain(`Docs/projects/${folder}/reports/quarterly.txt`);
    });
  }

  it('finds what such a folder holds, by its contents', async () => {
    const found = await withFile({
      relDir: 'projects/build',
      name: 'notes.txt',
      contents: 'the measurement was taken at dawn',
      term: 'dawn',
    });
    expect(found).toContain('Docs/projects/build/notes.txt');
  });

  it('finds the folder itself', async () => {
    const found = await withFile({
      relDir: 'projects/build/reports',
      name: 'quarterly.txt',
      term: 'build',
    });
    expect(found).toContain('Docs/projects/build');
  });

  it('finds it with the walker too, when ripgrep is not there', async () => {
    const found = await withFile({
      relDir: 'projects/build/reports',
      name: 'quarterly.txt',
      term: 'quarterly',
      env: { SEARCH_RIPGREP: 'false' },
    });
    expect(found).toContain('Docs/projects/build/reports/quarterly.txt');
  });
});

describe('what may still be left out', () => {
  // The mechanism that decides is the administrator's, not a name in the
  // source: removing the four must not remove this one.
  it('honours the exclusion list', async () => {
    const found = await withFile({
      relDir: 'private',
      name: 'quarterly.txt',
      term: 'quarterly',
      env: { SEARCH_INDEX_EXCLUDE: 'Docs/private' },
    });
    expect(found).toEqual([]);
  });

  it('leaves hidden folders hidden while the reader has not asked', async () => {
    const found = await withFile({
      relDir: '.private',
      name: 'quarterly.txt',
      term: 'quarterly',
    });
    expect(found).toEqual([]);
  });
});
