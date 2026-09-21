import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { useWalkingRipgrep } from '../helpers/fake-ripgrep.js';

/**
 * Somebody else's personal folder, searched for from the volume.
 *
 * Personal folders default to `<volume>/_users`. The volume refused to resolve
 * a path in there, and the search never resolves the paths it offers: it asks
 * whether each may be read, and nothing said no. The JavaScript walk stepped
 * over `_users` by name, which is why the machine these tests were first run
 * on never saw it; ripgrep, which the image ships, lists every file under the
 * volume, and so does the index. An ordinary account searching the volume was
 * offered another account's private files, by name and by what they said —
 * and searching for the account's name turned up a folder called `bob` at the
 * root, which does not exist, built by stepping over `_users` instead of
 * stopping there.
 *
 * Every engine is run, each with a way of telling that it was the one that
 * answered: an empty answer from the wrong engine proves nothing.
 */

let envContext;
let ripgrep;
const previousUserRoot = process.env.USER_ROOT;

afterEach(async () => {
  ripgrep?.restore();
  ripgrep = null;
  if (envContext) await envContext.cleanup();
  envContext = null;
  if (previousUserRoot === undefined) delete process.env.USER_ROOT;
  else process.env.USER_ROOT = previousUserRoot;
});

const ALICE = { id: 'alice', email: 'alice@example.com', roles: ['user'] };
const ADMIN = { id: 'admin', email: 'admin@example.com', roles: ['admin'] };

const writeDocx = async (absolutePath, text) => {
  const zip = new AdmZip();
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    )
  );
  await fs.writeFile(absolutePath, zip.toBuffer());
};

const ENGINES = {
  'the JavaScript walk': { env: { SEARCH_RIPGREP: 'false', SEARCH_INDEX: 'false' } },
  ripgrep: { env: { SEARCH_RIPGREP: 'true', SEARCH_INDEX: 'false' }, ripgrep: true },
  'the index': { env: { SEARCH_RIPGREP: 'false', SEARCH_INDEX: 'true' }, index: true },
  'the index beside ripgrep': {
    env: { SEARCH_RIPGREP: 'true', SEARCH_INDEX: 'true' },
    index: true,
    ripgrep: true,
  },
};

/**
 * Bob's folder, a public one, and a folder somebody else called `_users`.
 *
 * With the index, a file written after the pass tells it apart from the
 * storage: only reading the storage can find its words. Names are found by
 * reading the storage whatever the engine — the index answers contents — so
 * a file deleted after the pass is found by no engine at all.
 */
const seed = async (engine) => {
  if (engine.ripgrep) ripgrep = useWalkingRipgrep();
  envContext = await setupTestEnv({
    tag: 'search-personal-',
    env: { SEARCH_DEEP: 'true', USER_DIR_ENABLED: 'true', ...engine.env },
  });
  const volume = envContext.volumeDir;
  const bob = path.join(volume, '_users', 'bob');
  await fs.mkdir(bob, { recursive: true });
  await fs.writeFile(path.join(bob, 'secret-rapport.txt'), 'le mot pangolin');
  await writeDocx(path.join(bob, 'contrat-rapport.docx'), 'le mot pangolin');
  await fs.mkdir(path.join(volume, 'Public', '2026'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Public', 'ouvert-rapport.txt'), 'le mot pangolin');
  await fs.writeFile(path.join(volume, 'Public', 'fantome-rapport.txt'), 'x');
  await fs.mkdir(path.join(volume, 'Docs', '_users'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Docs', '_users', 'autre-rapport.txt'), 'le mot pangolin');
  await writeDocx(path.join(volume, 'Docs', '_users', 'autre-contrat.docx'), 'le mot pangolin');

  if (engine.index) {
    const db = await envContext.requireFresh('src/services/db').getDb();
    const { indexTree } = envContext.requireFresh('src/services/searchIndexer');
    const store = envContext.requireFresh('src/services/searchIndexStore');
    await indexTree({ db, rootAbs: volume, cpuPercent: 100 });
    store.markPassComplete(db);
    // The rows are there: whatever is kept out below is kept out by the
    // search, not by a pass that happened to skip the folder.
    const rows = db.prepare('SELECT path FROM search_documents').pluck().all();
    expect(rows).toContain('_users/bob/secret-rapport.txt');
  }

  await fs.rm(path.join(volume, 'Public', 'fantome-rapport.txt'));
  await fs.writeFile(path.join(volume, 'Public', 'neuf.txt'), 'le mot pangolin');
};

const searchAs = async (user, term, base = '') => {
  const searchRoutes = envContext.requireFresh('src/routes/search');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api', searchRoutes);
  app.use(errorHandler);
  const response = await request(app).get('/api/search').query({ q: term, path: base });
  expect(response.status).toBe(200);
  return (response.body.items || []).map((item) => `${item.path}/${item.name}`);
};

/** That the engine named is the one that answered. */
const expectEngine = (engine, { byName, byContents }) => {
  if (engine.ripgrep && !engine.index) {
    expect(ripgrep.calls().some((args) => args.includes('--files'))).toBe(true);
  }
  // Names come from the storage, whichever engine reads the contents.
  expect(byName).not.toContain('Public/fantome-rapport.txt');
  if (engine.index) {
    // Read from the storage only: written after the pass.
    expect(byContents).not.toContain('Public/neuf.txt');
  } else {
    expect(byContents).toContain('Public/neuf.txt');
  }
};

const fromSomebodysFolder = (found) =>
  found.filter((entry) => entry.includes('_users') || /(^|\/)bob(\/|$)/.test(entry));

for (const [name, engine] of Object.entries(ENGINES)) {
  describe(`searching the volume, answered by ${name}`, () => {
    for (const [who, user] of [
      ['an ordinary account', ALICE],
      ['an administrator', ADMIN],
    ]) {
      it(`keeps another account's folder from ${who}`, async () => {
        await seed(engine);

        const byName = await searchAs(user, 'rapport');
        const byContents = await searchAs(user, 'pangolin');
        const byFolder = await searchAs(user, 'bob');

        expect(byName).toContain('Public/ouvert-rapport.txt');
        expect(byContents).toContain('Public/ouvert-rapport.txt');
        expectEngine(engine, { byName, byContents });

        expect(fromSomebodysFolder(byName)).toEqual([]);
        expect(fromSomebodysFolder(byContents)).toEqual([]);
        expect(byFolder).toEqual([]);
      });
    }

    // A search inside `Public/2026` for `public` offered `Public` back — the
    // folder the reader was standing under.
    it('does not offer the folders above where the search started', async () => {
      await seed(engine);
      await fs.writeFile(path.join(envContext.volumeDir, 'Public', '2026', 'bilan.txt'), 'x');

      expect(await searchAs(ADMIN, 'public', 'Public/2026')).toEqual([]);
    });
  });
}

/**
 * Personal folders somewhere in the volume under a name of the operator's
 * choosing — `USER_ROOT=/data/homes`, with the volume at `/data`.
 *
 * `_users` is a name the search already steps around, which is what kept the
 * JavaScript walk clean above. `homes` is not: every engine went in, and the
 * only thing left to say no was the question nobody had asked — whose folder
 * is this.
 */
const seedWithHomes = async (engine) => {
  if (engine.ripgrep) ripgrep = useWalkingRipgrep();
  envContext = await setupTestEnv({
    tag: 'search-homes-',
    env: { SEARCH_DEEP: 'true', USER_DIR_ENABLED: 'true', ...engine.env },
  });
  const volume = envContext.volumeDir;
  // Before anything reads the configuration: every module was dropped by the
  // setup, and the next one required reads the environment afresh.
  process.env.USER_ROOT = path.join(volume, 'homes');
  const { directories } = envContext.requireFresh('src/config/index');
  expect(directories.userRoot).toBe(path.join(volume, 'homes'));

  await fs.mkdir(path.join(volume, 'homes', 'bob'), { recursive: true });
  await fs.writeFile(path.join(volume, 'homes', 'bob', 'secret-rapport.txt'), 'le mot pangolin');
  await fs.mkdir(path.join(volume, 'Public'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Public', 'ouvert-rapport.txt'), 'le mot pangolin');

  if (engine.index) {
    const db = await envContext.requireFresh('src/services/db').getDb();
    const { indexTree } = envContext.requireFresh('src/services/searchIndexer');
    const store = envContext.requireFresh('src/services/searchIndexStore');
    await indexTree({ db, rootAbs: volume, cpuPercent: 100 });
    store.markPassComplete(db);
    const rows = db.prepare('SELECT path FROM search_documents').pluck().all();
    expect(rows).toContain('homes/bob/secret-rapport.txt');
  }
};

for (const [name, engine] of Object.entries(ENGINES)) {
  describe(`personal folders under another name, answered by ${name}`, () => {
    it("keeps another account's folder from an ordinary account", async () => {
      await seedWithHomes(engine);

      const byName = await searchAs(ALICE, 'rapport');
      const byContents = await searchAs(ALICE, 'pangolin');

      expect(byName).toEqual(['Public/ouvert-rapport.txt']);
      expect(byContents).toEqual(['Public/ouvert-rapport.txt']);
      expect(await searchAs(ALICE, 'bob')).toEqual([]);
      if (engine.ripgrep && !engine.index) {
        expect(ripgrep.calls().some((args) => args.includes('--files'))).toBe(true);
      }
    });
  });
}

describe('the owner, in the personal space', () => {
  // The control for everything above: the folder is refused from the volume
  // and nowhere else.
  it('still finds their own files', async () => {
    await seed(ENGINES['the JavaScript walk']);
    const bob = { id: 'bob', email: 'bob@example.com', roles: ['user'] };

    expect(await searchAs(bob, 'secret', 'personal')).toEqual(['personal/secret-rapport.txt']);
  });
});
