import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Settings live in app.db, and only there.
 *
 * They used to be mirrored into app-config.json by one save path and read back
 * from it whenever app.db could not be read. The screens save through another
 * path, so the file stopped following the settings — and a read that failed ran
 * with whatever the file held, usually no access rules at all: reproduced, a
 * folder hidden by a rule answered `rw` for as long as the read kept failing.
 * The file is still read once by the migrations that carry very old settings
 * into app.db; nothing at runtime reads or writes it.
 */

let envContext;

afterEach(async () => {
  vi.restoreAllMocks();
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const setup = async () => {
  envContext = await setupTestEnv({ tag: 'settings-without-json-' });
  const db = await envContext.requireFresh('src/services/db').getDb();
  const accessControl = envContext.requireFresh('src/services/accessControlService');
  const settings = envContext.requireFresh('src/services/settingsService');
  return { db, accessControl, settings, file: path.join(envContext.configDir, 'app-config.json') };
};

/**
 * Make the read of the system settings fail, the way a damaged database does.
 *
 * Only that read: the branding is read from the same table, and failing both
 * would let a fallback in the system settings hide behind the branding's own
 * failure.
 */
const breakSettingsReads = (db) => {
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
  for (const method of ['get', 'all']) {
    const original = proto[method];
    vi.spyOn(proto, method).mockImplementation(function (...args) {
      if (/FROM system_settings WHERE category = \?\s*$/.test(this.source)) {
        throw Object.assign(new Error('database disk image is malformed'), {
          code: 'SQLITE_CORRUPT',
        });
      }
      return original.apply(this, args);
    });
  }
};

describe('access rules when the settings cannot be read', () => {
  it('refuse to answer rather than let a hidden folder open', async () => {
    const { db, accessControl } = await setup();
    await accessControl.setRules([{ path: 'Secret', recursive: true, permissions: 'hidden' }]);
    expect(await accessControl.getPermissionForPath('Secret/plan.pdf')).toBe('hidden');

    breakSettingsReads(db);

    await expect(accessControl.getPermissionForPath('Secret/plan.pdf')).rejects.toThrow(
      /malformed/
    );
  });

  it('do not fall back to an app-config.json left on disk, whatever it says', async () => {
    const { db, accessControl, file } = await setup();
    await accessControl.setRules([{ path: 'Secret', recursive: true, permissions: 'hidden' }]);
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 4, settings: { access: { rules: [] } }, favorites: [] })
    );

    breakSettingsReads(db);

    await expect(accessControl.getPermissionForPath('Secret/plan.pdf')).rejects.toThrow();
  });
});

describe('app-config.json at runtime', () => {
  it('is not created by reading the settings of a new installation', async () => {
    const { settings, accessControl, file } = await setup();

    await settings.getPublicSettings();
    await settings.getSettings();
    await accessControl.getRules();

    expect(fs.existsSync(file)).toBe(false);
  });

  it('is not written by saving settings, and one already there is left as it was', async () => {
    const { accessControl, settings, file } = await setup();
    const before = JSON.stringify({ version: 4, settings: {}, favorites: [] });
    fs.writeFileSync(file, before);

    await accessControl.setRules([{ path: 'Secret', recursive: true, permissions: 'ro' }]);
    await settings.setSettings({ thumbnails: { quality: 60 } });

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(await accessControl.getPermissionForPath('Secret/a.txt')).toBe('ro');
  });

  it('gives the sign-in page the default branding when none was saved', async () => {
    const { settings } = await setup();

    const { branding } = await settings.getPublicSettings();

    expect(branding).toEqual(expect.objectContaining({ appName: expect.any(String) }));
  });

  it('keeps the default branding when the saved one cannot be parsed', async () => {
    const { db, settings } = await setup();
    db.prepare(
      "INSERT INTO system_settings (id, category, key, value, updated_at) VALUES ('b', 'branding', 'branding', '{not json', ?)"
    ).run(new Date().toISOString());

    const { branding } = await settings.getPublicSettings();

    expect(branding).toEqual(expect.objectContaining({ appName: expect.any(String) }));
  });
});

// Database is imported for its prototype only through the connection above.
void Database;
