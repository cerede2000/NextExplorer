import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What a user chose for one folder, held as a row of its own.
 *
 * It used to be two JSON values per account under `user_settings` — one map of
 * sorts, one of views — read and rewritten whole on every change. Three things
 * followed from that, and all three are asserted here:
 *
 *   - Two tabs open on different folders overwrote each other. Each sent the
 *     whole map, so whichever saved last won and the other folder's choice was
 *     gone.
 *   - The map had to be capped, because it shipped entire on every load and was
 *     rewritten entire on every change. The hundred-and-first folder silently
 *     forgot the oldest.
 *   - Nothing could clean it up: a deleted folder's preferences stayed behind on
 *     every account that had ever opened it.
 *
 * The carry-over is asserted too. An installation that has the old values keeps
 * them: they are moved into rows, and the values they came from are removed so
 * a later version cannot read them back.
 */

const MODULES = ['src/services/db', 'src/services/settingsService'];

let envContext;
let settingsService;
let dbService;

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'folder-preferences-', modules: MODULES });
  dbService = envContext.requireFresh('src/services/db');
  settingsService = envContext.requireFresh('src/services/settingsService');

  const db = await dbService.getDb();
  const now = new Date().toISOString();
  for (const id of ['u-1', 'u-2']) {
    db.prepare('INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      id,
      `${id}@example.com`,
      now,
      now
    );
  }
});

afterEach(async () => {
  await envContext.cleanup();
});

const stored = (userId = 'u-1') => settingsService.getUserSettings(userId);

describe('a folder’s remembered sort and view', () => {
  it('is saved one folder at a time, so another folder’s choice survives it', async () => {
    await settingsService.setUserFolderSort('u-1', 'Projects', { by: 'name', order: 'desc' });
    await settingsService.setUserFolderSort('u-1', 'Music', { by: 'size', order: 'asc' });

    expect((await stored()).folderSorts).toMatchObject({
      Projects: { by: 'name', order: 'desc' },
      Music: { by: 'size', order: 'asc' },
    });
  });

  it('keeps the sort when the view of the same folder is set, and the other way round', async () => {
    await settingsService.setUserFolderSort('u-1', 'Projects', { by: 'name', order: 'desc' });
    await settingsService.setUserFolderView('u-1', 'Projects', { mode: 'photos' });

    const settings = await stored();
    expect(settings.folderSorts.Projects).toMatchObject({ by: 'name', order: 'desc' });
    expect(settings.folderViews.Projects).toMatchObject({ mode: 'photos' });
  });

  it('is one account’s alone', async () => {
    await settingsService.setUserFolderView('u-1', 'Projects', { mode: 'list' });
    await settingsService.setUserFolderView('u-2', 'Projects', { mode: 'grid' });

    expect((await stored('u-1')).folderViews.Projects).toMatchObject({ mode: 'list' });
    expect((await stored('u-2')).folderViews.Projects).toMatchObject({ mode: 'grid' });
  });

  /**
   * The hundred-and-first folder. As one value per account this was a ceiling,
   * and the oldest entry was dropped to stay under it; as rows there is nothing
   * to stay under.
   */
  it('is remembered past the hundred the single value could hold', async () => {
    for (let n = 0; n < 120; n += 1) {
      await settingsService.setUserFolderSort('u-1', `Folder-${n}`, { by: 'name', order: 'asc' });
    }

    const { folderSorts } = await stored();
    expect(Object.keys(folderSorts)).toHaveLength(120);
    expect(folderSorts['Folder-0']).toMatchObject({ by: 'name', order: 'asc' });
  });

  it('refuses a view mode there is no such thing as, rather than storing it', async () => {
    await settingsService.setUserFolderView('u-1', 'Projects', { mode: 'grid' });
    await settingsService.setUserFolderView('u-1', 'Projects', { mode: 'sideways' });

    expect((await stored()).folderViews.Projects).toMatchObject({ mode: 'grid' });
  });
});

/**
 * The installation that already had them.
 *
 * Built by putting the database back the way schema 19 left it — the two values
 * under `user_settings`, no table of rows, the version stamped back — and then
 * opening it again, which is the migration this batch adds.
 */
describe('preferences carried over from the single value per account', () => {
  const T = 1756300000000;

  const asSchema19 = async () => {
    const db = await dbService.getDb();
    const setting = (id, userId, key, value) =>
      db
        .prepare(
          'INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(id, userId, key, value, new Date(T).toISOString());

    setting(
      'us-1',
      'u-1',
      'folderSorts',
      JSON.stringify({
        Projects: { by: 'name', order: 'desc', updatedAt: T },
        Docs: { by: 'size', order: 'asc', updatedAt: T + 100 },
      })
    );
    setting(
      'us-2',
      'u-1',
      'folderViews',
      JSON.stringify({ Projects: { mode: 'grid', updatedAt: T + 200 } })
    );
    setting('us-3', 'u-2', 'folderSorts', '{ not json');
    setting('us-4', 'u-1', 'theme', '"dark"');

    db.exec('DROP TABLE folder_preferences');
    // The migration that makes the rows is v14 here and v20 upstream — the
    // numbers diverged long before this test existed, and `scripts/parity.mjs`
    // speaks for that under `residue`. So the version is put back to the one
    // *before ours*, and anybody moving this file between the two trees has that
    // one number to change.
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '13');
    await dbService.closeDb();

    envContext.requireFresh('src/services/db');
    dbService = envContext.requireFresh('src/services/db');
    settingsService = envContext.requireFresh('src/services/settingsService');
    return dbService.getDb();
  };

  it('makes one row per folder, merging the sort and the view under the later time', async () => {
    const db = await asSchema19();

    expect(
      db
        .prepare(
          `SELECT user_id, path, sort_by, sort_order, view_mode
             FROM folder_preferences ORDER BY user_id, path`
        )
        .all()
    ).toEqual([
      { user_id: 'u-1', path: 'Docs', sort_by: 'size', sort_order: 'asc', view_mode: null },
      { user_id: 'u-1', path: 'Projects', sort_by: 'name', sort_order: 'desc', view_mode: 'grid' },
    ]);
  });

  it('removes the values it read, including one it could not, and keeps the rest', async () => {
    const db = await asSchema19();

    expect(db.prepare('SELECT user_id, key FROM user_settings ORDER BY key').all()).toEqual([
      { user_id: 'u-1', key: 'theme' },
    ]);
  });

  it('serves them through what the application reads', async () => {
    await asSchema19();

    expect(await settingsService.getUserSettings('u-1')).toMatchObject({
      folderSorts: {
        Docs: { by: 'size', order: 'asc' },
        Projects: { by: 'name', order: 'desc' },
      },
      folderViews: { Projects: { mode: 'grid' } },
      theme: 'dark',
    });
  });
});
