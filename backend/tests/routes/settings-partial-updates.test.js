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
  return db;
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

  it('leaves thumbnails as they were when "enabled" is not a boolean', async () => {
    await seed();
    await patch(['admin'], { thumbnails: { enabled: false } });

    // Anything present used to count, and the service reads what is not a
    // boolean as on: "false" switched thumbnails on for everybody.
    const response = await patch(['admin'], { thumbnails: { enabled: 'false' } });

    expect(response.status).toBe(200);
    expect((await readAsAdmin()).thumbnails.enabled).toBe(false);
  });

  /** The one field where "nothing" is a value: no cap on the trash. */
  it('takes null for the trash size cap, which removes the cap', async () => {
    await seed();
    await patch(['admin'], { trash: { maxBytes: 5_000_000_000 } });

    await patch(['admin'], { trash: { maxBytes: null } });

    expect((await readAsAdmin()).trash.maxBytes).toBeNull();
  });
});

/**
 * A number, but not one anybody chose: what an emptied or mistyped field sends.
 *
 * The shape is right, so the check above let these through, and the service
 * brought each up to its lowest bound — a chunk size of 0 stored as 1 MiB, a
 * thumbnail size of 0 as 64 pixels — in place of what the administrator had.
 * A positive value beyond a bound is still brought within it.
 */
describe('a size or a count of nothing', () => {
  it.each([
    ['uploads.chunkSizeBytes', 0, 'uploads', 'chunkSizeBytes', 16 * MiB],
    ['uploads.chunkSizeBytes', -MiB, 'uploads', 'chunkSizeBytes', 16 * MiB],
    ['thumbnails.size', 0, 'thumbnails', 'size', 320],
    ['thumbnails.quality', -5, 'thumbnails', 'quality', 55],
    ['thumbnails.concurrency', 0, 'thumbnails', 'concurrency', 4],
    // The trash and the file versions, which the settings page already refuses
    // with these bounds — this is what an API client saw instead.
    ['trash.retentionDays', 0, 'trash', 'retentionDays', 90],
    ['trash.retentionDays', -5, 'trash', 'retentionDays', 90],
    ['trash.maxPercent', 0, 'trash', 'maxPercent', 40],
    ['trash.maxBytes', 0, 'trash', 'maxBytes', 5_000_000_000],
    ['versions.keepAllHours', 0, 'versions', 'keepAllHours', 48],
    ['versions.hourlyDays', -3, 'versions', 'hourlyDays', 14],
    ['versions.dailyDays', 0, 'versions', 'dailyDays', 60],
    ['versions.maxPerFile', 0, 'versions', 'maxPerFile', 7],
    ['versions.sessionCheckpointMinutes', -1, 'versions', 'sessionCheckpointMinutes', 30],
  ])('leaves %s as it was when sent %j', async (_label, sent, section, field, kept) => {
    await seed();
    await patch(['admin'], { [section]: { [field]: kept } });

    const response = await patch(['admin'], { [section]: { [field]: sent } });

    expect(response.status).toBe(200);
    expect((await readAsAdmin())[section][field]).toBe(kept);
  });

  it('still brings a positive value beyond its bounds within them', async () => {
    await seed();

    await patch(['admin'], {
      thumbnails: { size: 5000 },
      uploads: { chunkSizeBytes: 1024 },
      trash: { retentionDays: 9000 },
      versions: { maxPerFile: 5000 },
    });

    const settings = await readAsAdmin();
    expect(settings.thumbnails.size).toBe(1024);
    expect(settings.uploads.chunkSizeBytes).toBe(MiB);
    expect(settings.trash.retentionDays).toBe(3650);
    expect(settings.versions.maxPerFile).toBe(1000);
  });
});

describe('the application name', () => {
  it.each([[''], ['   ']])('is left as it was when sent as %j', async (appName) => {
    await seed();
    await patch(['admin'], { branding: { appName: 'Files' } });

    const response = await patch(['admin'], { branding: { appName } });

    expect(response.status).toBe(200);
    expect(response.body.branding.appName).toBe('Files');
    expect((await readAsAdmin()).branding.appName).toBe('Files');
  });

  it('reads as the default where an empty one was stored before', async () => {
    const db = await seed();
    db.prepare(
      `INSERT INTO system_settings (id, category, key, value, updated_at)
       VALUES ('b1', 'branding', 'branding', ?, ?)`
    ).run(JSON.stringify({ appName: '  ', appLogoUrl: '/logo.svg' }), new Date().toISOString());

    const response = await request(buildApp([])).get('/api/branding');

    expect(response.body.appName).toBe('Explorer');
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

/**
 * A rule the server cannot store as it was written.
 *
 * Every one of these used to be sanitised away with a 200: the row for
 * `../Secret` vanished from the page the moment it was saved, and an
 * administrator was left believing a folder was hidden that never was. Worse,
 * permissions that were not one of the three became `rw`, so a mistyped
 * `readonly` opened a folder for writing instead of refusing the word.
 *
 * Each one stores a good rule first, so a refusal can be told from a list that
 * was replaced by nothing.
 */
describe('an access rule the server cannot store', () => {
  const STORED = { id: 'kept', path: 'Private', permissions: 'hidden', recursive: true };

  it.each([
    [
      'a path that climbs out of the volume',
      { path: '../Secret', permissions: 'hidden' },
      /Traversal outside the volume root/,
    ],
    ['no path at all', { path: '', permissions: 'ro' }, /a rule needs the path of a folder/],
    [
      'permissions that are not one of the three',
      { path: 'Legal', permissions: 'readonly' },
      /is not one of the permissions/,
    ],
    [
      'a recursive flag that is not one',
      { path: 'Legal', permissions: 'ro', recursive: 'yes' },
      /does not say whether the rule covers what is inside/,
    ],
    ['something that is not a rule', 'Legal', /this is not a rule/],
  ])('is refused, with the reason, and changes nothing: %s', async (_label, rule, reason) => {
    await seed();
    await patch(['admin'], { access: { rules: [STORED] } });

    const response = await patch(['admin'], { access: { rules: [STORED, rule] } });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(reason);
    // Numbered as the page numbers the rows, so the reason names the one to fix.
    expect(response.body.error.message).toMatch(/^Access rule 2: /);
    expect((await readAsAdmin()).access.rules).toEqual([expect.objectContaining(STORED)]);
  });

  /**
   * Read back, the same rule is still dropped rather than refused. A value an
   * older version stored, or one edited into app.db by hand, must not make the
   * settings unreadable — unreadable settings are every hidden folder visible.
   */
  it('is dropped, not refused, when it is already in the database', async () => {
    const db = await seed();
    db.prepare(
      `INSERT INTO system_settings (id, category, key, value, updated_at)
       VALUES ('a1', 'system', 'access', ?, ?)`
    ).run(
      JSON.stringify({ rules: [STORED, { path: '../Secret', permissions: 'hidden' }] }),
      new Date().toISOString()
    );

    const settings = await readAsAdmin();

    expect(settings.access.rules).toEqual([expect.objectContaining(STORED)]);
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

/**
 * A save the route refuses halfway.
 *
 * One payload carries a section per group, and the sections used to be applied
 * one after another: a valid one before a refused one was stored, and the
 * answer was still 400. The person saw their save refused, the page kept the
 * values it had sent, and the server had taken some of them — the two
 * disagreed until the next reload, which is the worst state of the three.
 *
 * The access rules are the only section that refuses what it was sent, so they
 * are what makes this reachable. The sections are checked in the order they
 * are declared, and thumbnails come first: it is written before access is
 * reached, or it is not written at all.
 */
describe('a payload with a valid section and a refused one', () => {
  const REFUSED = { access: { rules: [{ path: 'Private', permissions: 'sideways' }] } };

  it('stores none of it, and says which rule it refused', async () => {
    await seed();
    await patch(['admin'], { thumbnails: { size: 321 } });

    const response = await patch(['admin'], { ...REFUSED, thumbnails: { size: 654 } });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/Access rule 1/);
    expect((await readAsAdmin()).thumbnails.size).toBe(321);
  });

  /**
   * The other direction, so this cannot pass on the order of the sections
   * alone: branding is written after access, and must be no more stored than
   * thumbnails was.
   */
  it('stores nothing that comes after the refusal either', async () => {
    await seed();
    await patch(['admin'], { branding: { appName: 'Before' } });

    const response = await patch(['admin'], { ...REFUSED, branding: { appName: 'After' } });

    expect(response.status).toBe(400);
    expect((await readAsAdmin()).branding.appName).toBe('Before');
  });

  /** A preference of one's own is not stored by a save the server refuses. */
  it('leaves the sender’s own preferences alone', async () => {
    await seed();
    await patch(['admin'], { user: { showHiddenFiles: true } });

    const response = await patch(['admin'], { ...REFUSED, user: { showHiddenFiles: false } });

    expect(response.status).toBe(400);
    expect((await readAsAdmin()).user.showHiddenFiles).toBe(true);
  });

  /** And a save with nothing wrong in it still writes every section it carries. */
  it('still writes every section when none of them is refused', async () => {
    await seed();

    const response = await patch(['admin'], {
      thumbnails: { size: 654 },
      branding: { appName: 'After' },
      access: { rules: [{ path: 'Private', permissions: 'hidden', recursive: true }] },
    });

    expect(response.status).toBe(200);
    const settings = await readAsAdmin();
    expect(settings.thumbnails.size).toBe(654);
    expect(settings.branding.appName).toBe('After');
    expect(settings.access.rules.map((rule) => rule.path)).toEqual(['Private']);
  });
});

/**
 * A rule that names no folder, and an exclusion list stored as it came.
 *
 * Both are the same kind of defect: something an administrator saved, that the
 * page then showed back to them, doing nothing. A path of nothing but spaces
 * normalises to itself, so it was stored and matched no folder. The search
 * index had no sanitiser on its way into storage, so its list kept whatever
 * spacing and repetition it arrived with — the worker was handed a clean copy
 * and behaved, which is exactly why nobody noticed the stored one.
 */
describe('what a rule and an exclusion list are held to', () => {
  it.each([['   '], ['\t'], [''], ['  \n ']])(
    'refuses an access rule whose path is %j',
    async (blank) => {
      await seed();

      const response = await patch(['admin'], {
        access: { rules: [{ path: blank, permissions: 'hidden' }] },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/Access rule 1.*folder/);
      expect((await readAsAdmin()).access.rules).toEqual([]);
    }
  );

  it('keeps a folder whose name has spaces in it', async () => {
    await seed();

    const response = await patch(['admin'], {
      access: { rules: [{ path: 'My Documents/Q1 2026', permissions: 'ro' }] },
    });

    expect(response.status).toBe(200);
    expect((await readAsAdmin()).access.rules.map((rule) => rule.path)).toEqual([
      'My Documents/Q1 2026',
    ]);
  });

  it('stores the search index exclusions as the worker is given them', async () => {
    const db = await seed();

    const response = await patch(['admin'], {
      searchIndex: { excludedPaths: ['  Private  ', 'Private', '', '/Cache/'] },
    });

    expect(response.status).toBe(200);
    const stored = JSON.parse(
      db
        .prepare(
          "SELECT value FROM system_settings WHERE category = 'system' AND key = 'searchIndex'"
        )
        .get().value
    );

    // Trimmed, emptied of nothing, and each folder once — the list the worker
    // is handed, rather than what the request happened to carry.
    expect(stored.excludedPaths).not.toContain('  Private  ');
    expect(stored.excludedPaths).not.toContain('');
    expect(stored.excludedPaths.filter((entry) => entry === 'Private')).toHaveLength(1);
    expect(stored.excludedPaths).toEqual((await readAsAdmin()).searchIndex.excludedPaths);
  });
});

/**
 * The access section is saved from two controls: the list of rules, and the one
 * switch above them that holds administrators to every rule.
 *
 * The route used to forward the rules alone. Saving them switched the setting
 * back off — silently widening what administrators could reach — and a request
 * that carried only the switch stored nothing at all, so turning it on did
 * nothing whatever the page showed. The service was right either way, which is
 * why only a test that goes through the route catches it.
 */
describe('the access section, saved half at a time', () => {
  const RULE = { path: 'Team', recursive: true, permissions: 'ro', appliesToAdmins: true };

  const storeBoth = () =>
    patch(['admin'], { access: { rules: [RULE], applyToAdmins: true } }).expect(200);

  it('keeps the switch when only the rules are sent', async () => {
    await seed();
    await storeBoth();

    await patch(['admin'], {
      access: { rules: [{ ...RULE, path: 'Finance' }] },
    }).expect(200);

    const { access } = await readAsAdmin();
    expect(access.applyToAdmins).toBe(true);
    expect(access.rules.map((rule) => rule.path)).toEqual(['Finance']);
  });

  it('keeps the rules when only the switch is sent', async () => {
    await seed();
    await storeBoth();

    await patch(['admin'], { access: { applyToAdmins: false } }).expect(200);

    const { access } = await readAsAdmin();
    expect(access.applyToAdmins).toBe(false);
    expect(access.rules.map((rule) => rule.path)).toEqual(['Team']);
  });

  it('stores what each rule says about administrators', async () => {
    await seed();

    await patch(['admin'], {
      access: {
        rules: [
          { path: 'Team', recursive: true, permissions: 'ro', appliesToAdmins: true },
          { path: 'Vault', recursive: true, permissions: 'hidden', appliesToAdmins: false },
        ],
      },
    }).expect(200);

    const { access } = await readAsAdmin();
    expect(access.rules.map((rule) => rule.appliesToAdmins)).toEqual([true, false]);
  });

  it('refuses a switch that is not a yes or a no, and stores nothing', async () => {
    await seed();
    await storeBoth();

    await patch(['admin'], { access: { applyToAdmins: 'yes' } }).expect(400);

    const { access } = await readAsAdmin();
    expect(access.applyToAdmins).toBe(true);
  });
});
