import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Two things the catalogue changed the shape of, and neither had a test.
 *
 * A name search used to be a walk, which compared strings in JavaScript and
 * asked the permission resolver about every candidate. It is a SQL scan now:
 * the term becomes part of a `LIKE`, where `%` and `_` mean something, and the
 * rows come back from a table that knows nothing about who may read what. Both
 * halves of that are worth stating rather than assuming.
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
    tag: 'search-terms-',
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

const buildIndex = async () => {
  const db = await envContext.requireFresh('src/services/indexDb').getIndexDb();
  const { indexTree } = envContext.requireFresh('src/services/searchIndexer');
  const store = envContext.requireFresh('src/services/searchIndexStore');
  await indexTree({ db, rootAbs: envContext.volumeDir, cpuPercent: 100 });
  store.markPassComplete(db);
  expect(store.hasNameCatalogue(db)).toBe(true);
};

const search = async (term) => {
  const response = await request(buildApp()).get('/api/search').query({ q: term });
  expect(response.status).toBe(200);
  return (response.body.items || []).map((item) => `${item.path}/${item.name}`);
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('what a typed term may contain', () => {
  // `%` and `_` are the two characters SQL reads as "anything" — the first as
  // any run, the second as any single character. A term is typed by a person,
  // so both are just characters, and a search for a discount of 100% must not
  // offer everything beginning with 100.
  it('treats the wildcards of SQL as ordinary characters', async () => {
    const volume = await seed();
    const docs = path.join(volume, 'Docs');
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(path.join(docs, 'remise 100% acquise.txt'), 'x');
    await fs.writeFile(path.join(docs, 'remise 1006 acquise.txt'), 'x');
    await fs.writeFile(path.join(docs, 'un_sous_tiret.txt'), 'x');
    await fs.writeFile(path.join(docs, 'unXsousYtiret.txt'), 'x');
    await buildIndex();

    expect(await search('100%')).toEqual(['Docs/remise 100% acquise.txt']);
    expect(await search('un_sous')).toEqual(['Docs/un_sous_tiret.txt']);
  });

  // Everything after `--` is positional for ripgrep, which is what keeps a term
  // starting with a dash from being read as a flag. The catalogue has no such
  // hazard, and both have to answer the same.
  it('takes a term that begins with a dash', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Docs'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Docs', '-commence-par-tiret.txt'), 'x');
    await buildIndex();

    expect(await search('-commence')).toEqual(['Docs/-commence-par-tiret.txt']);
  });

  it('takes a term with a space in it', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Docs'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Docs', 'proces verbal 2026.txt'), 'x');
    await fs.writeFile(path.join(volume, 'Docs', 'proces-verbal-2026.txt'), 'x');
    await buildIndex();

    expect(await search('proces verbal')).toEqual(['Docs/proces verbal 2026.txt']);
  });

  it('answers across the volumes, not only the first', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Usb', 'a'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Nvm'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Usb', 'a', 'rapport-usb.txt'), 'x');
    await fs.writeFile(path.join(volume, 'Nvm', 'rapport-nvm.txt'), 'x');
    await buildIndex();

    expect(await search('rapport')).toEqual(['Nvm/rapport-nvm.txt', 'Usb/a/rapport-usb.txt']);
  });
});

describe('what the catalogue may not reveal', () => {
  /**
   * The rows come from a table that knows nothing about who may read what, and
   * they no longer pass through the walk that used to be the thing asking. The
   * permission resolver is consulted on every result instead — and the point of
   * a test here is that a mistake in this direction is not a wrong answer, it
   * is a disclosure.
   */
  const withHiddenFolder = async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Prive'), { recursive: true });
    await fs.mkdir(path.join(volume, 'Public'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Prive', 'secret-rapport.txt'), 'le mot pangolin');
    await fs.writeFile(path.join(volume, 'Public', 'ouvert-rapport.txt'), 'le mot pangolin');
    await buildIndex();

    // Both are there to begin with: an empty answer below would otherwise
    // prove nothing at all. Ordered by the name, the two being the same length
    // and equally close to the term.
    expect(await search('rapport')).toEqual([
      'Public/ouvert-rapport.txt',
      'Prive/secret-rapport.txt',
    ]);

    const accessControl = envContext.requireFresh('src/services/accessControlService');
    await accessControl.setRules([{ path: 'Prive', recursive: true, permissions: 'hidden' }]);
  };

  it('keeps a hidden folder out of a search by name', async () => {
    await withHiddenFolder();
    expect(await search('rapport')).toEqual(['Public/ouvert-rapport.txt']);
  });

  it('keeps it out of a search by contents', async () => {
    await withHiddenFolder();
    expect(await search('pangolin')).toEqual(['Public/ouvert-rapport.txt']);
  });

  it('does not offer the folder itself either', async () => {
    await withHiddenFolder();
    expect(await search('Prive')).toEqual([]);
  });
});

describe('a term too short to be worth answering', () => {
  // One or two characters describe most of a volume. The catalogue would
  // answer — a scan is a scan — with the first hundred rows that happen to
  // hold the letter, which is not something anybody asked for; the walk reads
  // the whole storage to say the same.
  it('refuses fewer than three characters', async () => {
    await seed();

    for (const term of ['a', 'ab']) {
      const response = await request(buildApp()).get('/api/search').query({ q: term });
      expect(response.status).toBe(400);
    }
  });

  it('answers three', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Docs'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Docs', 'abc-rapport.txt'), 'x');
    await buildIndex();

    expect(await search('abc')).toEqual(['Docs/abc-rapport.txt']);
  });
});

describe('a word the reader has only begun to type', () => {
  /**
   * FTS5 matches whole words. Searching `azul` found nothing at all while
   * `azules` found the document holding it — the index and the live scan
   * answering two different questions from the same box, and the shorter term
   * being the one that failed, which reads as the search being broken.
   */
  const withSpanish = async (env) => {
    const volume = await seed(env);
    await fs.mkdir(path.join(volume, 'Docs'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Docs', 'film.json'), '{"Title":"Los azules del mar"}');
    return volume;
  };

  it('finds the word from its beginning, through the index', async () => {
    await withSpanish();
    await buildIndex();

    expect(await search('azul')).toEqual(['Docs/film.json']);
    expect(await search('azules')).toEqual(['Docs/film.json']);
  });

  it('finds it the same way without the index', async () => {
    await withSpanish({ SEARCH_INDEX: 'false' });

    expect(await search('azul')).toEqual(['Docs/film.json']);
  });
});
