import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { substituteModule } from '../helpers/substitute-module.js';

/**
 * Two saves of one settings section, in flight at the same moment.
 *
 * The page sends what changed rather than the whole document, so the server
 * merges each section over what is stored. That merge used to read the
 * settings at the start of the request and write the result two awaits later:
 * two administrators saving at once, or one with the settings open in two
 * tabs, both started from the same stored value and the second wrote over the
 * first's field — while telling the person who set it that it was saved.
 * Branding was taken out of that path already, where a lost save also left a
 * logo file behind; every other section had the same hole.
 *
 * The database answers synchronously, so a read and a write with nothing
 * awaited between them cannot be interleaved. That is what is pinned here: the
 * moment where the second request could slip in is the `await` on the database
 * handle, and both requests are held at it until both have arrived. With the
 * read and the write on either side of it, the second overwrites the first;
 * with both after it, the second reads what the first has just written.
 */

const SERVICE_FILE = fileURLToPath(
  new URL('../../src/services/settingsService.js', import.meta.url)
);

let currentEnv;
let restore = null;

afterEach(async () => {
  restore?.();
  restore = null;
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

/**
 * Hold the first two callers until both have arrived, and let everything after
 * them straight through.
 */
const holdFirstTwo = () => {
  let arrived = 0;
  let release;
  const both = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived > 2) return;
    if (arrived === 2) release();
    await both;
  };
};

const buildApp = () => {
  const routes = currentEnv.requireFresh('src/routes/settings');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'u1', email: 'u@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

/**
 * An application whose settings service waits on the gate every time it asks
 * for the database handle.
 */
const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'settings-concurrent-' });
  const db = currentEnv.requireFresh('src/services/db');
  await db.getDb();

  const gate = holdFirstTwo();
  // Substituted after the environment cleared the module registry, so the
  // settings service required next is the one that receives this.
  restore = substituteModule(SERVICE_FILE, './db', {
    ...db,
    getDb: async () => {
      await gate();
      return db.getDb();
    },
  });

  return buildApp();
};

const patch = (app, payload) => request(app).patch('/api/settings').send(payload);
const readAsAdmin = async (app) => (await request(app).get('/api/settings')).body;

describe('two saves of one settings section at once', () => {
  it.each([
    ['the trash', 'trash', { retentionDays: 90 }, { maxPercent: 40 }],
    ['file versions', 'versions', { maxPerFile: 7 }, { dailyDays: 60 }],
    ['thumbnails', 'thumbnails', { size: 320 }, { quality: 55 }],
    ['uploads', 'uploads', { chunkSizeBytes: 16 * 1024 * 1024 }, { chunkedEnabled: true }],
  ])('keep both fields: %s', async (_label, section, first, second) => {
    const app = await seed();

    const answers = await Promise.all([
      patch(app, { [section]: first }),
      patch(app, { [section]: second }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect((await readAsAdmin(app))[section]).toMatchObject({ ...first, ...second });
  });

  /**
   * The exclusions are a list rather than a set of fields, so the two saves
   * cannot both survive — the second replaces the list. What must hold is that
   * the one the person is told about is the one that is stored.
   */
  it('leaves the folder size exclusions as the last answer says they are', async () => {
    const app = await seed();

    const answers = await Promise.all([
      patch(app, { folderSize: { excludedPaths: ['Archive'] } }),
      patch(app, { folderSize: { excludedPaths: ['Archive', 'Backups'] } }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const stored = (await readAsAdmin(app)).folderSize.excludedPaths;
    expect(stored).toEqual(answers.at(-1).body.folderSize.excludedPaths);
  });
});
