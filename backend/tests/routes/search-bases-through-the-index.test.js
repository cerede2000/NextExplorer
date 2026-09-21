import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A search that starts somewhere the reader names differently from the index.
 *
 * The index names a file by its path in the volume. Inside a link the reader
 * names it `share/<token>/…`, in their own folder `personal/…`, in a volume an
 * administrator assigned them `<label>/…`. Those searches used to read the
 * storage, on every keystroke, because the index could not be asked in their
 * words — the cost the index exists to remove, on exactly the bases where the
 * people who are not administrators work.
 *
 * Each test proves the index answered, because an answer read from the
 * storage is the same answer: a file the index knows and the disk no longer
 * has can only be named by the index, and a file written after the pass can
 * only be read from the disk.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const seed = async (env = {}) => {
  envContext = await setupTestEnv({
    tag: 'search-bases-',
    env: { SEARCH_DEEP: 'true', SEARCH_INDEX: 'true', USER_DIR_ENABLED: 'true', ...env },
  });
  const db = await envContext.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  for (const [id, roles] of [
    ['u1', '["admin"]'],
    ['alice', '["user"]'],
  ]) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(id, `${id}@example.com`, id, id, roles, now, now);
  }
  return envContext.volumeDir;
};

/**
 * `folder` holds a file found by name and by what it says, and the two
 * witnesses: `fantome-rapport.txt`, indexed and then deleted, and `neuf.txt`,
 * written after the pass.
 */
const fillFolder = async (folder) => {
  await fs.mkdir(path.join(folder, 'sous'), { recursive: true });
  await fs.writeFile(path.join(folder, 'sous', 'rapport-2026.txt'), 'du texte pangolin');
  await fs.writeFile(path.join(folder, 'fantome-rapport.txt'), 'x');
};

const buildIndex = async (...folders) => {
  const db = await envContext.requireFresh('src/services/indexDb').getIndexDb();
  const { indexTree } = envContext.requireFresh('src/services/searchIndexer');
  const store = envContext.requireFresh('src/services/searchIndexStore');
  await indexTree({ db, rootAbs: envContext.volumeDir, cpuPercent: 100 });
  store.markPassComplete(db);
  expect(store.hasNameCatalogue(db)).toBe(true);

  for (const folder of folders) {
    await fs.rm(path.join(folder, 'fantome-rapport.txt'));
    await fs.writeFile(path.join(folder, 'neuf.txt'), 'pangolin arrivé depuis');
  }
};

const appFor = (who) => {
  const searchRoutes = envContext.requireFresh('src/routes/search');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use((req, _res, next) => {
    if (who.user) req.user = who.user;
    if (who.guestSession) req.guestSession = who.guestSession;
    next();
  });
  app.use('/api', searchRoutes);
  app.use(errorHandler);
  return app;
};

const search = async (who, base, term, query = {}) => {
  const response = await request(appFor(who))
    .get('/api/search')
    .query({ q: term, path: base, ...query });
  expect(response.status).toBe(200);
  return (response.body.items || []).map((item) => `${item.path}/${item.name}`);
};

/** What a search at `base` answers, and that it was the index answering. */
const expectIndexAnswered = async (who, base) => {
  const byName = await search(who, base, 'rapport');
  const byContents = await search(who, base, 'pangolin');

  expect(byName).toEqual([`${base}/sous/rapport-2026.txt`, `${base}/fantome-rapport.txt`]);
  expect(byContents).toEqual([`${base}/sous/rapport-2026.txt`]);
};

const ALICE = { user: { id: 'alice', email: 'alice@example.com', roles: ['user'] } };

const shareOf = async (source) => {
  const shares = envContext.requireFresh('src/services/sharesService');
  return shares.createShare({
    ownerId: 'u1',
    isDirectory: true,
    accessMode: 'readonly',
    ...source,
  });
};

const visitorOf = (share) => ({ guestSession: { shareId: share.id } });

describe('a shared folder', () => {
  it('is answered by the index, in the words of the link', async () => {
    const volume = await seed();
    const folder = path.join(volume, 'Docs', 'partage');
    await fillFolder(folder);
    const share = await shareOf({ sourceSpace: 'volume', sourcePath: 'Docs/partage' });
    await buildIndex(folder);

    await expectIndexAnswered(visitorOf(share), `share/${share.shareToken}`);
  });

  // `Docs/partage-bis` begins with the same letters as `Docs/partage`. The
  // folder range in SQL is what tells them apart, and the way back from a row
  // is what would hand one over if it did not.
  it('offers nothing from a neighbour whose name begins the same way', async () => {
    const volume = await seed();
    const folder = path.join(volume, 'Docs', 'partage');
    await fillFolder(folder);
    await fs.mkdir(path.join(volume, 'Docs', 'partage-bis'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Docs', 'partage-bis', 'voisin-rapport.txt'), 'pangolin');
    await fs.writeFile(path.join(volume, 'Docs', 'hors-rapport.txt'), 'pangolin');
    const share = await shareOf({ sourceSpace: 'volume', sourcePath: 'Docs/partage' });
    await buildIndex(folder);
    await expectIndexAnswered(visitorOf(share), `share/${share.shareToken}`);

    for (const term of ['rapport', 'pangolin', 'voisin', 'partage']) {
      const found = await search(visitorOf(share), `share/${share.shareToken}`, term);
      expect(found.every((entry) => entry.startsWith(`share/${share.shareToken}/`))).toBe(true);
      expect(found.some((entry) => /voisin|hors/.test(entry))).toBe(false);
    }
  });

  /**
   * The index was asked for the best few hundred documents across the whole
   * volume and the folder's were picked out afterwards. A word common
   * elsewhere filled those few hundred before the folder had a turn, and the
   * share answered with nothing.
   */
  it('finds its document when the word is everywhere else first', async () => {
    const volume = await seed();
    const folder = path.join(volume, 'Docs', 'partage');
    await fillFolder(folder);
    const elsewhere = path.join(volume, 'Ailleurs');
    await fs.mkdir(elsewhere, { recursive: true });
    for (let index = 0; index < 60; index += 1) {
      await fs.writeFile(path.join(elsewhere, `n${index}.txt`), 'pangolin pangolin pangolin');
    }
    const share = await shareOf({ sourceSpace: 'volume', sourcePath: 'Docs/partage' });
    await buildIndex(folder);

    // Ten asked for, fifty fetched: the sixty elsewhere rank higher than the
    // one in the share, which mentions the word once among others.
    expect(
      await search(visitorOf(share), `share/${share.shareToken}`, 'pangolin', { limit: 10 })
    ).toEqual([`share/${share.shareToken}/sous/rapport-2026.txt`]);
  });

  it('keeps out a folder an administrator hid inside it', async () => {
    const volume = await seed();
    const folder = path.join(volume, 'Docs', 'partage');
    await fillFolder(folder);
    await fs.mkdir(path.join(folder, 'cache'), { recursive: true });
    await fs.writeFile(path.join(folder, 'cache', 'cache-rapport.txt'), 'pangolin');
    const share = await shareOf({ sourceSpace: 'volume', sourcePath: 'Docs/partage' });
    await buildIndex(folder);

    const accessControl = envContext.requireFresh('src/services/accessControlService');
    await accessControl.setRules([
      { path: 'Docs/partage/cache', recursive: true, permissions: 'hidden' },
    ]);

    await expectIndexAnswered(visitorOf(share), `share/${share.shareToken}`);
  });

  // The pass does not follow links, so the files are indexed under where they
  // really are; the share is asked about there.
  it('is answered when the shared folder is reached through a link', async () => {
    const volume = await seed();
    const folder = path.join(volume, 'Docs', 'vrai');
    await fillFolder(folder);
    await fs.symlink(folder, path.join(volume, 'Docs', 'lien'));
    const share = await shareOf({ sourceSpace: 'volume', sourcePath: 'Docs/lien' });
    await buildIndex(folder);

    await expectIndexAnswered(visitorOf(share), `share/${share.shareToken}`);
  });

  // Created since the last pass: the index has no row for it, and asking would
  // answer with silence where the disk has a file.
  it('is read from the storage where the index has not been yet', async () => {
    const volume = await seed();
    const folder = path.join(volume, 'Docs', 'partage');
    await fillFolder(folder);
    const share = await shareOf({ sourceSpace: 'volume', sourcePath: 'Docs/partage' });
    await buildIndex(folder);

    // One folder down: the folder searched from is always read directly, so a
    // file in it would be found whoever answered.
    await fs.mkdir(path.join(folder, 'arrive', 'dedans'), { recursive: true });
    await fs.writeFile(
      path.join(folder, 'arrive', 'dedans', 'tardif-rapport.txt'),
      'ornithorynque'
    );

    const base = `share/${share.shareToken}/arrive`;
    expect(await search(visitorOf(share), base, 'rapport')).toEqual([
      `${base}/dedans/tardif-rapport.txt`,
    ]);
    expect(await search(visitorOf(share), base, 'ornithorynque')).toEqual([
      `${base}/dedans/tardif-rapport.txt`,
    ]);
  });
});

describe("somebody's own folder", () => {
  it('is answered by the index, in the personal space', async () => {
    const volume = await seed();
    const folder = path.join(volume, '_users', 'alice');
    await fillFolder(folder);
    await buildIndex(folder);

    await expectIndexAnswered(ALICE, 'personal');
  });

  it('is answered by the index, through a share of it', async () => {
    const volume = await seed();
    const folder = path.join(volume, '_users', 'u1', 'Projets');
    await fillFolder(folder);
    const share = await shareOf({ sourceSpace: 'personal', sourcePath: 'Projets' });
    await buildIndex(folder);

    await expectIndexAnswered(visitorOf(share), `share/${share.shareToken}`);
  });

  // Alice's folder sits beside Bob's, and a search of hers is asked about hers.
  it("offers nothing from the next account's folder", async () => {
    const volume = await seed();
    const folder = path.join(volume, '_users', 'alice');
    await fillFolder(folder);
    await fs.mkdir(path.join(volume, '_users', 'alice2'), { recursive: true });
    await fs.writeFile(path.join(volume, '_users', 'alice2', 'autre-rapport.txt'), 'pangolin');
    await buildIndex(folder);
    await expectIndexAnswered(ALICE, 'personal');

    for (const term of ['rapport', 'pangolin', 'autre']) {
      const found = await search(ALICE, 'personal', term);
      expect(found.some((entry) => entry.includes('autre'))).toBe(false);
    }
  });
});

describe('a volume an administrator assigned', () => {
  it('is answered by the index, under its label', async () => {
    const volume = await seed({ USER_VOLUMES: 'true' });
    const folder = path.join(volume, 'Docs', 'equipe');
    await fillFolder(folder);
    const volumes = envContext.requireFresh('src/services/userVolumesService');
    await volumes.addVolumeToUser({ userId: 'alice', label: 'Equipe', volumePath: folder });
    await buildIndex(folder);

    await expectIndexAnswered(ALICE, 'Equipe');
  });
});
