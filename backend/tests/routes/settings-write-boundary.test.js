import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Who may change what, on the one endpoint that writes every setting.
 *
 * `PATCH /api/settings` takes a single payload with a section per group and
 * decides section by section: anyone signed in may change their own
 * preferences, only an administrator may change the ones that affect everybody.
 * Fifty-five paths through one function, and only the read side of that
 * boundary had a test — a regular account being refused the *write* did not.
 *
 * The response is the whole settings document rather than a list of changes,
 * so what is asserted is the value before and after, not the shape of a reply.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'settings-write-', env });
  const dbService = currentEnv.requireFresh('src/services/db');
  const db = await dbService.getDb();
  // A preference is stored against an account that has to exist; without the
  // row the write fails on a foreign key and the route answers 500.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1','u@example.com',1,'u','U','["user"]', ?, ?)`
  ).run(now, now);
};

const buildApp = (roles) => {
  const routes = currentEnv.requireFresh('src/routes/settings');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'u1', email: 'u@example.com', roles };
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

const patch = (roles, payload) => request(buildApp(roles)).patch('/api/settings').send(payload);
const read = (roles) => request(buildApp(roles)).get('/api/settings');

/**
 * One writable field per section that only an administrator may touch, with a
 * value that differs from the default, so a change is visible either way.
 */
const SYSTEM_CHANGES = [
  ['thumbnails', { size: 321 }, (settings) => settings.thumbnails?.size],
  ['uploads', { chunkedEnabled: true }, (settings) => settings.uploads?.chunkedEnabled],
  ['branding', { appName: 'Renamed' }, (settings) => settings.branding?.appName],
  [
    'folderSize',
    { excludedPaths: ['Sneaked/in'] },
    (settings) => settings.folderSize?.excludedPaths?.join(),
  ],
  [
    'searchIndex',
    { excludedPaths: ['Sneaked/in'] },
    (settings) => settings.searchIndex?.excludedPaths?.join(),
  ],
];

describe('what only an administrator may change', () => {
  /**
   * Refused outright rather than quietly dropped. Answering 200 to a change
   * that was not made is worse than saying no: the page that asked has no way
   * to tell, and shows the value the person typed.
   */
  it.each(SYSTEM_CHANGES)(
    'is refused, and unchanged, when a regular account asks: %s',
    async (section, value, readBack) => {
      await seed();
      const before = readBack((await read(['admin'])).body);

      const response = await patch(['user'], { [section]: value });

      expect(response.status).toBe(403);
      expect(readBack((await read(['admin'])).body)).toEqual(before);
    }
  );

  it.each(SYSTEM_CHANGES)(
    'is applied when an administrator asks: %s',
    async (section, value, readBack) => {
      await seed();
      const before = readBack((await read(['admin'])).body);

      await patch(['admin'], { [section]: value });

      const after = readBack((await read(['admin'])).body);
      expect(after).not.toEqual(before);
    }
  );

  /**
   * A payload that mixes the two is refused whole, and the preference in it is
   * not kept either.
   *
   * It used to be: the user section was applied first and the refusal raised
   * afterwards, so this answered 403 with the preference already saved. A
   * request reported as refused that changed something is the one answer a
   * caller cannot act on.
   */
  it('refuses a payload that mixes its own preference with a system one', async () => {
    await seed();

    const response = await patch(['user'], {
      branding: { appName: 'Taken over' },
      user: { markdownOpensInEditor: true },
    });

    expect(response.status).toBe(403);
    expect((await read(['user'])).body.user?.markdownOpensInEditor).not.toBe(true);
    expect((await read(['admin'])).body.branding?.appName).not.toBe('Taken over');
  });

  it('takes a preference on its own from a regular account', async () => {
    await seed();

    const response = await patch(['user'], { user: { markdownOpensInEditor: true } });

    expect(response.status).toBe(200);
    expect(response.body.user?.markdownOpensInEditor).toBe(true);
  });
});

describe('what a value has to look like to be stored', () => {
  it('takes a boolean from anything truthy, since a checkbox may send either', async () => {
    await seed();

    const response = await patch(['admin'], { thumbnails: { enabled: 'yes' } });

    expect(response.body.thumbnails.enabled).toBe(true);
  });

  /**
   * A size that is not a number is a size nobody chose. Storing it would put
   * something that is not a pixel count where one belongs, and every thumbnail
   * generated afterwards would carry it.
   *
   * Refused twice — once by the route and once by the service that stores it —
   * so neither mutation alone fails this. Removing both does. Said out loud
   * because a single surviving mutation reads like a gap and is not one.
   */
  it.each([['not-a-number'], [null], [Infinity]])(
    'keeps the size it had when given %s',
    async (size) => {
      await seed();
      const before = (await read(['admin'])).body.thumbnails.size;

      await patch(['admin'], { thumbnails: { size } });

      expect((await read(['admin'])).body.thumbnails.size).toBe(before);
    }
  );

  it('takes a size that is a number', async () => {
    await seed();

    await patch(['admin'], { thumbnails: { size: 256 } });

    expect((await read(['admin'])).body.thumbnails.size).toBe(256);
  });

  it('ignores a section that is not an object', async () => {
    await seed();
    const before = (await read(['admin'])).body.thumbnails;

    const response = await patch(['admin'], { thumbnails: 'enabled please' });

    expect(response.status).toBe(200);
    expect((await read(['admin'])).body.thumbnails).toEqual(before);
  });
});
