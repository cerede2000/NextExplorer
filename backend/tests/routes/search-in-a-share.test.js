import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Searching inside a shared folder, as the visitor of a link.
 *
 * A share resolves to a folder inside the volume and is described by another
 * name: `share/<token>/…`, which is what every result carries and what every
 * permission check is made against. The index knows the same files under their
 * volume paths.
 *
 * With the index on, the search consulted it for a base it had never heard of,
 * matched nothing, and answered nothing — while having skipped the live scan
 * precisely because the index was there. The visitor saw an empty result for a
 * file in front of them.
 *
 * Both halves are covered because both were affected: contents since the index
 * was added, names since the catalogue was.
 */

let envContext;

const app = (share) => {
  const searchRoutes = envContext.requireFresh('src/routes/search');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const server = express();
  // A visitor of the link: no account, a guest session on this share.
  server.use((req, _res, next) => {
    req.guestSession = { shareId: share.id };
    next();
  });
  server.use('/api', searchRoutes);
  server.use(errorHandler);
  return server;
};

/** A shared folder holding one file, and one file outside it. */
const seed = async (env = {}) => {
  envContext = await setupTestEnv({
    tag: 'search-share-',
    env: { SEARCH_DEEP: 'true', ...env },
  });
  const db = await envContext.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1', 'u@example.com', 1, 'u', 'U', '["admin"]', ?, ?)`
  ).run(now, now);

  const shared = path.join(envContext.volumeDir, 'Docs', 'partage');
  await fs.mkdir(path.join(shared, 'sous'), { recursive: true });
  await fs.writeFile(path.join(shared, 'sous', 'rapport-2026.txt'), 'du texte pangolin');
  await fs.writeFile(
    path.join(envContext.volumeDir, 'Docs', 'dehors-rapport.txt'),
    'pangolin dehors'
  );

  const shares = envContext.requireFresh('src/services/sharesService');
  return shares.createShare({
    ownerId: 'u1',
    sourceSpace: 'volume',
    sourcePath: 'Docs/partage',
    isDirectory: true,
    accessMode: 'readonly',
  });
};

/** One finished pass, and the mark that says so. */
const buildIndex = async () => {
  const db = await envContext.requireFresh('src/services/indexDb').getIndexDb();
  const { indexTree } = envContext.requireFresh('src/services/searchIndexer');
  const store = envContext.requireFresh('src/services/searchIndexStore');
  await indexTree({ db, rootAbs: envContext.volumeDir, cpuPercent: 100 });
  store.markPassComplete(db);
  expect(store.hasNameCatalogue(db)).toBe(true);
};

const search = async (share, term) => {
  const response = await request(app(share))
    .get('/api/search')
    .query({ q: term, path: `share/${share.shareToken}` });
  expect(response.status).toBe(200);
  return (response.body.items || []).map((item) => `${item.path}/${item.name}`);
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('with the index on', () => {
  it('finds a file in the share by its name', async () => {
    const share = await seed({ SEARCH_INDEX: 'true' });
    await buildIndex();

    expect(await search(share, 'rapport')).toEqual([
      `share/${share.shareToken}/sous/rapport-2026.txt`,
    ]);
  });

  it('finds one by what it says', async () => {
    const share = await seed({ SEARCH_INDEX: 'true' });
    await buildIndex();

    expect(await search(share, 'pangolin')).toEqual([
      `share/${share.shareToken}/sous/rapport-2026.txt`,
    ]);
  });

  // The file outside carries both words. A visitor of the link has no business
  // knowing it exists, and no business learning where the share sits on disk.
  it('answers about the share and nothing above it', async () => {
    const share = await seed({ SEARCH_INDEX: 'true' });
    await buildIndex();

    for (const term of ['rapport', 'pangolin']) {
      const found = await search(share, term);
      // Said first: an empty answer satisfies every rule below it and proves
      // none of them.
      expect(found).toHaveLength(1);
      expect(found.every((entry) => entry.startsWith(`share/${share.shareToken}/`))).toBe(true);
      expect(found.some((entry) => entry.includes('dehors'))).toBe(false);
    }
  });
});

describe('with the index off', () => {
  it('answers the same, by reading the folder', async () => {
    const share = await seed({ SEARCH_INDEX: 'false' });

    expect(await search(share, 'rapport')).toEqual([
      `share/${share.shareToken}/sous/rapport-2026.txt`,
    ]);
    expect(await search(share, 'pangolin')).toEqual([
      `share/${share.shareToken}/sous/rapport-2026.txt`,
    ]);
  });
});
