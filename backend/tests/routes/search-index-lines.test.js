import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The line shown under a result the index found by its contents.
 *
 * The index keeps words, not text, so that line is read back from the file.
 * It was read for every candidate, one after the other, for up to three pages
 * of them and before permissions were asked — and a search waited for all of
 * it. The index had answered in milliseconds; on a network share, where every
 * file comes back across the wire and a PDF is converted again, each search
 * then ran to the end of its time budget (#11).
 *
 * A slow disk is played here by a line reader that takes its time, since what
 * is being tested is what the search does while it waits, not the disk.
 */

let envContext;

const seed = async (env = {}) => {
  envContext = await setupTestEnv({
    tag: 'search-index-lines-',
    env: { SEARCH_INDEX: 'true', SEARCH_DEEP: 'true', ...env },
  });
  const db = await envContext.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1', 'u@example.com', 1, 'u', 'U', '["admin"]', ?, ?)`
  ).run(now, now);
  return envContext.volumeDir;
};

const writeMatches = async (folder, count) => {
  await fs.mkdir(folder, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const name = `note-${String(index).padStart(3, '0')}.txt`;
    await fs.writeFile(path.join(folder, name), `ligne une\nle pangolin numero ${index}\n`);
  }
};

const buildIndex = async () => {
  const db = await envContext.requireFresh('src/services/indexDb').getIndexDb();
  const { indexTree } = envContext.requireFresh('src/services/searchIndexer');
  const store = envContext.requireFresh('src/services/searchIndexStore');
  await indexTree({ db, rootAbs: envContext.volumeDir, cpuPercent: 100 });
  store.markPassComplete(db);
};

/**
 * Every line read through a reader that waits `ms` first, and counted.
 *
 * Installed on the module before the route is loaded, because the route takes
 * its functions from it when it is loaded.
 */
const slowLines = (ms) => {
  const documentText = envContext.requireFresh('src/services/documentText');
  const original = documentText.findPlainTextMatch;
  const read = [];
  vi.spyOn(documentText, 'findPlainTextMatch').mockImplementation(async (file, ...rest) => {
    read.push(file);
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
    return original(file, ...rest);
  });
  return read;
};

const search = async (term, query = {}) => {
  const searchRoutes = envContext.requireFresh('src/routes/search');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'u1', email: 'u@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', searchRoutes);
  app.use(errorHandler);

  const started = Date.now();
  const response = await request(app)
    .get('/api/search')
    .query({ q: term, ...query });
  expect(response.status).toBe(200);
  return { body: response.body, elapsed: Date.now() - started };
};

afterEach(async () => {
  vi.restoreAllMocks();
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('lines that are slow to read', () => {
  for (const ripgrep of ['true', 'false']) {
    it(`does not hold the answer for them (ripgrep ${ripgrep})`, async () => {
      const volume = await seed({ SEARCH_TIMEOUT_MS: '6000', SEARCH_RIPGREP: ripgrep });
      await writeMatches(path.join(volume, 'Docs'), 30);
      await buildIndex();
      // Thirty reads of eight hundred milliseconds: twenty-four seconds one
      // after the other, and six even four at a time — the whole budget.
      slowLines(800);

      const { body, elapsed } = await search('pangolin');

      // Two seconds of lines, then the rest as the index gave them — well
      // inside the budget, and nothing cut short.
      expect(elapsed).toBeLessThan(4000);
      expect(body.truncated).toBe(false);
      expect(body.items).toHaveLength(30);
      for (const item of body.items) expect(item.matchedContent).toBe(true);

      const withLine = body.items.filter((item) => item.matchLine);
      const without = body.items.filter((item) => !item.matchLine);
      // Read four at a time: two rounds of four fit in the two seconds, where
      // one at a time would have shown two lines.
      expect(withLine.length).toBeGreaterThanOrEqual(5);
      expect(withLine[0].matchLine).toContain('pangolin');
      // The others say where they were found, and carry nothing that was not
      // asked for.
      expect(without.length).toBeGreaterThan(0);
      for (const item of without) {
        expect(item).not.toHaveProperty('inContents');
        expect(item).not.toHaveProperty('score');
      }
    }, 20000);
  }
});

describe('lines that come quickly', () => {
  it('are all shown, as before', async () => {
    const volume = await seed({ SEARCH_RIPGREP: 'false' });
    await writeMatches(path.join(volume, 'Docs'), 10);
    await buildIndex();

    const { body } = await search('pangolin');

    expect(body.items).toHaveLength(10);
    for (const item of body.items) {
      expect(item.matchLine).toContain('pangolin');
      expect(item.matchLineNumber).toBe(2);
    }
  });

  it('are not read for more results than the page can hold', async () => {
    const volume = await seed({ SEARCH_RIPGREP: 'false' });
    await writeMatches(path.join(volume, 'Docs'), 60);
    await buildIndex();
    const read = slowLines(0);

    const { body } = await search('pangolin', { limit: 10 });

    expect(body.items).toHaveLength(10);
    // Ten for the page, and no more than the few already being read when it
    // filled. It used to be every row the index handed over — fifty here.
    expect(read.length).toBeLessThanOrEqual(14);
  });

  it('leaves out a file that no longer says what the index remembers', async () => {
    const volume = await seed({ SEARCH_RIPGREP: 'false' });
    await writeMatches(path.join(volume, 'Docs'), 3);
    await buildIndex();
    await fs.writeFile(path.join(volume, 'Docs', 'note-001.txt'), 'plus rien\n');

    const { body } = await search('pangolin');

    expect(body.items.map((item) => item.name).sort()).toEqual(['note-000.txt', 'note-002.txt']);
  });
});

describe('a file the reader may not see', () => {
  it('is not opened to find its line', async () => {
    const volume = await seed({ SEARCH_RIPGREP: 'false' });
    await writeMatches(path.join(volume, 'Prive'), 5);
    await writeMatches(path.join(volume, 'Public'), 5);
    await buildIndex();
    const accessControl = envContext.requireFresh('src/services/accessControlService');
    await accessControl.setRules([{ path: 'Prive', recursive: true, permissions: 'hidden' }]);
    const read = slowLines(0);

    const { body } = await search('pangolin');

    expect(body.items.every((item) => item.path === 'Public')).toBe(true);
    expect(body.items).toHaveLength(5);
    expect(read.filter((file) => file.includes(`${path.sep}Prive${path.sep}`))).toEqual([]);
  });
});
