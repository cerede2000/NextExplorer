import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A settings write that sends part of a section, or sends a field in the wrong
 * shape.
 *
 * The settings page sends what changed, not the whole document, so the route
 * merges each section over what is stored. And it drops a field that is not in
 * the shape the field takes before anything is stored — which matters more than
 * it looks, because the service underneath repairs a bad value by putting the
 * *default* in its place. Without the route's check, a trash retention of
 * ninety days sent back as "forever" becomes thirty, and an access rule list
 * sent as anything other than a list becomes no rules at all: every folder an
 * administrator had hidden, visible again.
 *
 * So every case here first stores a value that differs from the default, then
 * sends the bad one, then reads back — a test that started from the default
 * could not tell the route's refusal from the service's repair.
 *
 * Who may write which section is pinned in `settings-write-boundary.test.js`.
 */

const MiB = 1024 * 1024;

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'settings-partial-' });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
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
const readAsAdmin = async () => (await request(buildApp(['admin'])).get('/api/settings')).body;

describe('a field sent in a shape it does not take', () => {
  it.each([
    [
      'thumbnails.quality',
      { thumbnails: { quality: 55 } },
      { thumbnails: { quality: 'best' } },
      (s) => s.thumbnails.quality,
      55,
    ],
    [
      'uploads.chunkSizeBytes',
      { uploads: { chunkSizeBytes: 16 * MiB } },
      { uploads: { chunkSizeBytes: 'huge' } },
      (s) => s.uploads.chunkSizeBytes,
      16 * MiB,
    ],
    [
      'uploads.chunkedEnabled',
      { uploads: { chunkedEnabled: true } },
      { uploads: { chunkedEnabled: 'yes' } },
      (s) => s.uploads.chunkedEnabled,
      true,
    ],
    [
      'trash.retentionDays',
      { trash: { retentionDays: 90 } },
      { trash: { retentionDays: 'forever' } },
      (s) => s.trash.retentionDays,
      90,
    ],
    [
      'trash.maxBytes',
      { trash: { maxBytes: 5_000_000_000 } },
      { trash: { maxBytes: 'lots' } },
      (s) => s.trash.maxBytes,
      5_000_000_000,
    ],
    [
      'versions.maxPerFile',
      { versions: { maxPerFile: 7 } },
      { versions: { maxPerFile: 'many' } },
      (s) => s.versions.maxPerFile,
      7,
    ],
    [
      'branding.appName',
      { branding: { appName: 'Files' } },
      { branding: { appName: 42 } },
      (s) => s.branding.appName,
      'Files',
    ],
  ])(
    'leaves %s as it was, not reset to its default',
    async (_field, stored, sent, readBack, kept) => {
      await seed();
      await patch(['admin'], stored);
      expect(readBack(await readAsAdmin())).toEqual(kept);

      const response = await patch(['admin'], sent);

      expect(response.status).toBe(200);
      expect(readBack(await readAsAdmin())).toEqual(kept);
    }
  );

  /** The one field where "nothing" is a value: no cap on the trash. */
  it('takes null for the trash size cap, which removes the cap', async () => {
    await seed();
    await patch(['admin'], { trash: { maxBytes: 5_000_000_000 } });

    await patch(['admin'], { trash: { maxBytes: null } });

    expect((await readAsAdmin()).trash.maxBytes).toBeNull();
  });
});

describe('a section sent with only some of its fields', () => {
  it('changes those fields and leaves the rest of the section as it was', async () => {
    await seed();
    await patch(['admin'], {
      trash: { retentionDays: 90, maxPercent: 40 },
      versions: { maxPerFile: 7, dailyDays: 60 },
    });

    await patch(['admin'], { trash: { retentionDays: 7 }, versions: { maxPerFile: 9 } });

    const { trash, versions } = await readAsAdmin();
    expect(trash).toMatchObject({ retentionDays: 7, maxPercent: 40 });
    expect(versions).toMatchObject({ maxPerFile: 9, dailyDays: 60 });
  });
});

describe('a list sent as something that is not a list', () => {
  const HIDDEN_RULE = { path: 'Private', permissions: 'hidden', recursive: true };
  const rulesOf = (settings) => settings.access.rules.map((r) => `${r.path}:${r.permissions}`);

  it.each([
    [
      'the access rules',
      { access: { rules: [HIDDEN_RULE] } },
      { access: { rules: 'none' } },
      rulesOf,
      ['Private:hidden'],
    ],
    [
      'the access rules, when the list is missing',
      { access: { rules: [HIDDEN_RULE] } },
      { access: {} },
      rulesOf,
      ['Private:hidden'],
    ],
    [
      'the search index exclusions',
      { searchIndex: { excludedPaths: ['Private'] } },
      { searchIndex: { excludedPaths: 'Elsewhere' } },
      (s) => s.searchIndex.excludedPaths,
      ['Private'],
    ],
    [
      'the folder size exclusions',
      { folderSize: { excludedPaths: ['Private'] } },
      { folderSize: { excludedPaths: null } },
      (s) => s.folderSize.excludedPaths,
      ['Private'],
    ],
  ])('leaves %s in place', async (_label, stored, sent, readBack, kept) => {
    await seed();
    await patch(['admin'], stored);
    expect(readBack(await readAsAdmin())).toEqual(kept);

    const response = await patch(['admin'], sent);

    expect(response.status).toBe(200);
    expect(readBack(await readAsAdmin())).toEqual(kept);
  });
});

describe('what a regular account may not change', () => {
  /**
   * `settings-write-boundary.test.js` covers one field of five sections. These
   * are the other three, and the access rules are the ones that decide which
   * folders anybody may see.
   */
  it.each([
    ['the access rules', { access: { rules: [] } }, (s) => s.access.rules.length, 1],
    ['the trash', { trash: { retentionDays: 1 } }, (s) => s.trash.retentionDays, 90],
    ['the file versions', { versions: { maxPerFile: 1 } }, (s) => s.versions.maxPerFile, 7],
  ])('is refused, and unchanged: %s', async (_label, sent, readBack, kept) => {
    await seed();
    await patch(['admin'], {
      access: { rules: [{ path: 'Private', permissions: 'hidden', recursive: true }] },
      trash: { retentionDays: 90 },
      versions: { maxPerFile: 7 },
    });

    const response = await patch(['user'], sent);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Admin access required for system settings.');
    expect(readBack(await readAsAdmin())).toBe(kept);
  });
});
