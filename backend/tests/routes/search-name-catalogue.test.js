import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Finding a file by its name without walking the storage.
 *
 * The index replaced the live content scan the day it arrived; names went on
 * enumerating the whole tree on every search. On a local disk that is
 * invisible — fifty thousand files answer in about a tenth of a second — and
 * on a share mounted over SMB it is the entire cost, one round trip per
 * directory, a budget spent before there is an answer. Reported in #11 as a
 * search that returns by timing out.
 *
 * So every file gets a row, whether or not any words could be taken out of it,
 * and a name search reads that instead. What the catalogue cannot answer it
 * does not pretend to: a pass that has not finished, a reader who has asked to
 * see hidden files, a folder outside the volume.
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
    tag: 'search-catalogue-',
    env: { SEARCH_INDEX: 'true', SEARCH_DEEP: 'true', SEARCH_RIPGREP: 'true', ...env },
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

/** One pass over the volume, and the mark that says it reached the end. */
const buildIndex = async ({ complete = true } = {}) => {
  const db = await envContext.requireFresh('src/services/indexDb').getIndexDb();
  const { indexTree } = envContext.requireFresh('src/services/searchIndexer');
  const store = envContext.requireFresh('src/services/searchIndexStore');
  await indexTree({ db, rootAbs: envContext.volumeDir, cpuPercent: 100 });
  if (complete) store.markPassComplete(db);
  return { db, store };
};

const search = async (term, query = {}) => {
  const response = await request(buildApp())
    .get('/api/search')
    .query({ q: term, ...query });
  expect(response.status).toBe(200);
  return (response.body.items || []).map((item) => `${item.path}/${item.name}`);
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('a name the index can answer for', () => {
  it('finds a file that has no words in it at all', async () => {
    const docs = await seed();
    await fs.mkdir(path.join(docs, 'photos/2026'), { recursive: true });
    // A PNG header and a null byte: nothing a text pass would keep.
    await fs.writeFile(
      path.join(docs, 'photos/2026/vacances-corse.png'),
      Buffer.from('\x89PNG\r\n\x1a\n\u0000 rien a lire ici', 'binary')
    );
    await buildIndex();

    expect(await search('vacances')).toContain('Docs/photos/2026/vacances-corse.png');
  });

  it('does not pretend that file has words', async () => {
    const docs = await seed();
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(
      path.join(docs, 'blob.dat'),
      Buffer.from('pangolin\u0000pangolin and more', 'binary')
    );
    await buildIndex();

    expect(await search('pangolin')).toEqual([]);
  });

  it('finds a folder by its own name', async () => {
    const docs = await seed();
    await fs.mkdir(path.join(docs, 'chantier-nord/photos'), { recursive: true });
    await fs.writeFile(path.join(docs, 'chantier-nord/photos/dsc_0001.jpg'), 'x');
    await buildIndex();

    // Nothing inside it carries the word, which is why the folder needs a
    // question of its own rather than riding on the rows of its files.
    expect(await search('chantier')).toContain('Docs/chantier-nord');
  });

  it('finds a file too large to have been read', async () => {
    const docs = await seed({ SEARCH_MAX_FILESIZE: '1K' });
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(path.join(docs, 'reunion-annuelle.mov'), Buffer.alloc(4096, 0x41));
    await buildIndex();

    expect(await search('reunion')).toContain('Docs/reunion-annuelle.mov');
  });

  it('matches a name however its accents were written', async () => {
    const docs = await seed();
    await fs.mkdir(docs, { recursive: true });
    // Decomposed on disk, the shape a file arriving from a Mac carries.
    await fs.writeFile(path.join(docs, 'Résumé-2026.pdf'), 'x');
    await buildIndex();

    expect(await search('Résumé')).toHaveLength(1);
  });

  it('answers a pattern as well as a word', async () => {
    const docs = await seed();
    await fs.mkdir(path.join(docs, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(docs, 'scripts/deploy.ps1'), 'x');
    await fs.writeFile(path.join(docs, 'scripts/notes.txt'), 'x');
    await buildIndex();

    expect(await search('*.ps1')).toEqual(['Docs/scripts/deploy.ps1']);
  });

  // What proves the answer came from the catalogue and not from a walk: a file
  // the storage no longer holds. Results are as fresh as the last pass, which
  // is the trade being made here, and it is also the only thing a walk could
  // never say.
  it('answers from the catalogue, and not from the storage', async () => {
    const docs = await seed();
    await fs.mkdir(path.join(docs, 'loin/dessous'), { recursive: true });
    await fs.writeFile(path.join(docs, 'loin/dessous/disparu-ensuite.txt'), 'x');
    const { db, store } = await buildIndex();
    expect(store.hasNameCatalogue(db)).toBe(true);

    await fs.rm(path.join(docs, 'loin/dessous/disparu-ensuite.txt'));

    expect(await search('disparu')).toContain('Docs/loin/dessous/disparu-ensuite.txt');
  });

  it('keeps to the folder the search was started from', async () => {
    const docs = await seed();
    await fs.mkdir(path.join(docs, 'nord'), { recursive: true });
    await fs.mkdir(path.join(docs, 'sud'), { recursive: true });
    await fs.writeFile(path.join(docs, 'nord/rapport.txt'), 'x');
    await fs.writeFile(path.join(docs, 'sud/rapport.txt'), 'x');
    await buildIndex();

    expect(await search('rapport', { path: 'Docs/nord' })).toEqual(['Docs/nord/rapport.txt']);
  });
});

describe('what the catalogue is not asked to answer', () => {
  it('reads the folder in front of the reader from the storage', async () => {
    const docs = await seed();
    await fs.mkdir(docs, { recursive: true });
    await buildIndex();
    // Dropped on the share after the pass, the way an rsync does it.
    await fs.writeFile(path.join(docs, 'arrive-apres.txt'), 'x');

    expect(await search('arrive', { path: 'Docs' })).toContain('Docs/arrive-apres.txt');
  });

  it('walks the tree while no pass has finished', async () => {
    const docs = await seed();
    await fs.mkdir(path.join(docs, 'a/b'), { recursive: true });
    await fs.writeFile(path.join(docs, 'a/b/tardif.txt'), 'x');
    await buildIndex({ complete: false });

    // Half an index is not an index: until a pass ends, the storage answers,
    // and it answers about everything.
    expect(await search('tardif')).toContain('Docs/a/b/tardif.txt');
  });

  it('walks the tree for a reader who asked to see hidden files', async () => {
    const docs = await seed();
    await fs.mkdir(path.join(docs, '.prive'), { recursive: true });
    await fs.writeFile(path.join(docs, '.prive/secret-rapport.txt'), 'x');
    await buildIndex();

    const settings = envContext.requireFresh('src/services/settingsService');
    await settings.setUserSetting('u1', 'showHiddenFiles', true);

    // The pass does not go into dot-folders, so the catalogue has nothing to
    // say here and must not be the one answering.
    expect(await search('secret')).toContain('Docs/.prive/secret-rapport.txt');
  });

  it('serves an index written before names were kept by walking instead', async () => {
    const docs = await seed();
    await fs.mkdir(path.join(docs, 'a'), { recursive: true });
    await fs.writeFile(path.join(docs, 'a/ancien.txt'), 'x');
    const { db, store } = await buildIndex();

    // What a database from an earlier version looks like: a finished pass, and
    // no record of which shape it left behind.
    db.prepare('DELETE FROM meta WHERE key = ?').run('search_index_catalogue_version');
    expect(store.hasNameCatalogue(db)).toBe(false);

    expect(await search('ancien')).toContain('Docs/a/ancien.txt');
  });
});

describe('an index built before names were kept', () => {
  /**
   * What an upgrade actually looks like: a volume whose index is finished and
   * holds rows only for the files words could be taken out of. Nothing about
   * it is wrong — it answers a content search correctly — and a name search
   * has to keep walking until a pass has been all the way round again.
   */
  const buildTheOldWay = async () => {
    const db = await envContext.requireFresh('src/services/indexDb').getIndexDb();
    const store = envContext.requireFresh('src/services/searchIndexStore');
    const { indexTree } = envContext.requireFresh('src/services/searchIndexer');
    await indexTree({ db, rootAbs: envContext.volumeDir, cpuPercent: 100 });
    store.markPassComplete(db);
    // Now make it the shape the older release left behind: the rows that hold
    // no words were never written, and nothing recorded which shape it was.
    db.prepare(
      'DELETE FROM search_documents WHERE id NOT IN (SELECT rowid FROM search_terms)'
    ).run();
    db.prepare('DELETE FROM meta WHERE key = ?').run('search_index_catalogue_version');
    return { db, store };
  };

  it('walks until a pass has been round again, then stops', async () => {
    const docs = await seed();
    await fs.mkdir(path.join(docs, 'photos/2019'), { recursive: true });
    await fs.writeFile(path.join(docs, 'lisible.txt'), 'du texte ordinaire');
    await fs.writeFile(
      path.join(docs, 'photos/2019/bapteme-louise.jpg'),
      Buffer.from('\xff\xd8\xff\u0000 binaire', 'binary')
    );

    const { db, store } = await buildTheOldWay();
    expect(store.hasNameCatalogue(db)).toBe(false);
    // The photograph has no row at all, and the search finds it anyway —
    // because the storage is still what answers.
    expect(store.stats(db).files).toBe(1);
    expect(await search('bapteme')).toContain('Docs/photos/2019/bapteme-louise.jpg');

    // One pass, the same one that already runs every hour.
    const manager = envContext.requireFresh('src/services/searchIndexManager');
    await manager.reconcile({ reason: 'test' });

    expect(store.hasNameCatalogue(db)).toBe(true);
    expect(store.stats(db).files).toBe(2);
    expect(await search('bapteme')).toContain('Docs/photos/2019/bapteme-louise.jpg');
  });

  it('gives the rows it already had a name to be found by', async () => {
    const docs = await seed();
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(path.join(docs, 'proces-verbal.md'), 'du texte ordinaire');

    const { db, store } = await buildTheOldWay();
    // The column arrives empty on a database that predates it; filling it from
    // the paths already stored is what the schema step does, and without it a
    // finished pass would answer nothing for a file it has held all along.
    db.prepare("UPDATE search_documents SET name_fold = ''").run();
    store.ensureNameColumn(db);

    expect(db.prepare('SELECT name_fold FROM search_documents').pluck().get()).toBe(
      'proces-verbal.md'
    );
  });
});

describe('with no ripgrep on the machine', () => {
  it('still answers a name from the catalogue', async () => {
    const docs = await seed({ SEARCH_RIPGREP: 'false' });
    await fs.mkdir(path.join(docs, 'photos'), { recursive: true });
    await fs.writeFile(
      path.join(docs, 'photos/inventaire-2026.png'),
      Buffer.from('\x89PNG\u0000x', 'binary')
    );
    await buildIndex();

    expect(await search('inventaire')).toContain('Docs/photos/inventaire-2026.png');
  });

  it('still reads contents through the index beside it', async () => {
    const docs = await seed({ SEARCH_RIPGREP: 'false' });
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(path.join(docs, 'compte-rendu.md'), 'le mot pangolin est ici\n');
    await buildIndex();

    expect(await search('pangolin')).toContain('Docs/compte-rendu.md');
  });
});

describe('what a result says it was found by', () => {
  /** The whole response, not just the paths. */
  const results = async (term) => {
    const response = await request(buildApp()).get('/api/search').query({ q: term });
    expect(response.status).toBe(200);
    return response.body.items || [];
  };

  const seedThree = async (env) => {
    const docs = await seed(env);
    await fs.mkdir(docs, { recursive: true });
    // Its name carries the word and its text does not.
    await fs.writeFile(path.join(docs, 'pangolin-photo.jpg'), 'rien de lisible');
    // Its text carries the word and its name does not.
    await fs.writeFile(path.join(docs, 'notes.md'), 'le mot pangolin est ici');
    // Both.
    await fs.writeFile(path.join(docs, 'pangolin-notes.md'), 'le mot pangolin est ici aussi');
    return docs;
  };

  it('says of every result whether its name matched', async () => {
    await seedThree();
    await buildIndex();

    const found = Object.fromEntries((await results('pangolin')).map((i) => [i.name, i]));

    expect(found['pangolin-photo.jpg'].matchedName).toBe(true);
    expect(found['notes.md'].matchedName).toBe(false);
    expect(found['pangolin-notes.md'].matchedName).toBe(true);
  });

  // The name half must not depend on which pass reserved the path first — that
  // is the thing that made one file look different from one search to the next.
  it('says the same about a name with the catalogue and without it', async () => {
    await seedThree({ SEARCH_INDEX: 'false' });

    const found = Object.fromEntries((await results('pangolin')).map((i) => [i.name, i]));

    expect(found['pangolin-photo.jpg'].matchedName).toBe(true);
    expect(found['notes.md'].matchedName).toBe(false);
    expect(found['pangolin-notes.md'].matchedName).toBe(true);
  });

  // And the contents half claims exactly what it shows. A file listed for its
  // name is not opened to find out whether its text matched as well; reading it
  // is the cost the index is there to avoid.
  it('claims contents only where it shows a line', async () => {
    await seedThree();
    await buildIndex();

    const items = await results('pangolin');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.matchedContent).toBe(Boolean(item.matchLine));
    }
  });
});

describe('the order names come back in', () => {
  const names = async (term) => {
    const response = await request(buildApp()).get('/api/search').query({ q: term });
    expect(response.status).toBe(200);
    return (response.body.items || []).map((item) => item.name);
  };

  // Neither source has an order anybody asked for: the catalogue hands back
  // rows in the order the pass met them, a walk in the order the storage lists
  // them. Whichever answered, the closest name comes first.
  it('puts the whole name first, then what begins with it', async () => {
    const docs = await seed();
    await fs.mkdir(docs, { recursive: true });
    for (const name of [
      'vieux-rapport-2019-annexe.pdf',
      'rapport-2026.pdf',
      'rapport',
      'un-rapport-quelconque.txt',
      'rapport-de-visite.pdf',
    ]) {
      await fs.writeFile(path.join(docs, name), 'x');
    }
    await buildIndex();

    expect(await names('rapport')).toEqual([
      'rapport',
      'rapport-2026.pdf',
      'rapport-de-visite.pdf',
      'un-rapport-quelconque.txt',
      'vieux-rapport-2019-annexe.pdf',
    ]);
  });

  it('orders the same way when the catalogue is not the one answering', async () => {
    const docs = await seed({ SEARCH_INDEX: 'false' });
    await fs.mkdir(docs, { recursive: true });
    for (const name of ['vieux-rapport.pdf', 'rapport-2026.pdf', 'rapport']) {
      await fs.writeFile(path.join(docs, name), 'x');
    }

    expect(await names('rapport')).toEqual(['rapport', 'rapport-2026.pdf', 'vieux-rapport.pdf']);
  });
});
