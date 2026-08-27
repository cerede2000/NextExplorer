import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What the database ties to a path has to follow that path, or forget it.
 *
 * Files move and disappear, and the rows pointing at them did not follow: a
 * favorite outlived the folder it named, a share kept pointing at a path that
 * no longer existed, and a folder's sort order was inherited by whatever folder
 * happened to be created at the same place next. Deleting cleaned up the
 * favorites of whoever deleted and nobody else's, which is the part that made
 * it a bug rather than an omission — these are other people's rows.
 */

describe('path bindings', () => {
  let env;

  const setup = async () => {
    env = await setupTestEnv({
      tag: 'path-bindings-',
      modules: [
        'src/services/db',
        'src/services/pathBindingsService',
        'src/services/settingsService',
        'src/services/accessManager',
        'src/routes/files',
        'src/middleware/errorHandler',
      ],
    });

    await fs.mkdir(path.join(env.volumeDir, 'Projects', 'reports'), { recursive: true });
    await fs.writeFile(path.join(env.volumeDir, 'Projects', 'reports', 'q1.txt'), 'contents');
    await fs.mkdir(path.join(env.volumeDir, 'Archive'), { recursive: true });
  };

  const appFor = (user) => {
    const routes = env.requireFresh('src/routes/files');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    return createTestApp({ router: routes, mountPath: '/api', user, errorHandler });
  };

  /** Two people who both care about the same folder. */
  const givenBothUsersCareAbout = async (folderPath) => {
    const db = await env.requireFresh('src/services/db').getDb();
    const now = new Date().toISOString();

    for (const userId of ['alice', 'bob']) {
      // favorites references users(id); these have to exist first.
      db.prepare(
        `INSERT OR IGNORE INTO users
           (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
      ).run(userId, `${userId}@example.com`, userId, userId, now, now);

      db.prepare(
        `INSERT INTO favorites (id, user_id, path, label, icon, created_at, updated_at, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `fav-${userId}-${folderPath}`,
        userId,
        folderPath,
        'Reports',
        'outline:StarIcon',
        now,
        now,
        0
      );

      db.prepare('INSERT INTO recent_destinations (user_id, path, used_at) VALUES (?, ?, ?)').run(
        userId,
        folderPath,
        now
      );

      db.prepare(
        `INSERT INTO folder_preferences (user_id, path, sort_by, sort_order, view_mode, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(userId, folderPath, 'name', 'asc', 'list', now);
    }
  };

  const countFor = async (table, column, value) => {
    const db = await env.requireFresh('src/services/db').getDb();
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(value)
      .count;
  };

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('forgets everything tied to a deleted folder, for every user', async () => {
    // The bug this replaces: deleting cleaned up the favorites of whoever
    // pressed delete, leaving everyone else pointing at a folder that is gone.
    await setup();
    await givenBothUsersCareAbout('Projects/reports');

    const deleted = await request(appFor({ id: 'alice', roles: ['admin'] }))
      .delete('/api/files')
      .send({ items: [{ name: 'reports', path: 'Projects' }] });
    expect(deleted.status).toBe(200);

    expect(await countFor('favorites', 'path', 'Projects/reports')).toBe(0);
    expect(await countFor('recent_destinations', 'path', 'Projects/reports')).toBe(0);
    expect(await countFor('folder_preferences', 'path', 'Projects/reports')).toBe(0);
  });

  it('forgets what pointed inside a deleted folder too', async () => {
    await setup();
    await givenBothUsersCareAbout('Projects/reports/q1');

    await request(appFor({ id: 'alice', roles: ['admin'] }))
      .delete('/api/files')
      .send({ items: [{ name: 'Projects', path: '' }] });

    expect(await countFor('favorites', 'path', 'Projects/reports/q1')).toBe(0);
    expect(await countFor('folder_preferences', 'path', 'Projects/reports/q1')).toBe(0);
  });

  it('follows a renamed folder rather than being left behind', async () => {
    await setup();
    await givenBothUsersCareAbout('Projects/reports');

    const renamed = await request(appFor({ id: 'alice', roles: ['admin'] }))
      .post('/api/files/rename')
      .send({ path: 'Projects', name: 'reports', newName: 'quarterly' });
    expect(renamed.status).toBe(200);

    expect(await countFor('favorites', 'path', 'Projects/reports')).toBe(0);
    expect(await countFor('favorites', 'path', 'Projects/quarterly')).toBe(2);
    expect(await countFor('folder_preferences', 'path', 'Projects/quarterly')).toBe(2);
    expect(await countFor('recent_destinations', 'path', 'Projects/quarterly')).toBe(2);
  });

  it('carries what was inside a renamed folder with it', async () => {
    // A favorite two levels down still names the same folder afterwards.
    await setup();
    await givenBothUsersCareAbout('Projects/reports/q1');

    await request(appFor({ id: 'alice', roles: ['admin'] }))
      .post('/api/files/rename')
      .send({ path: 'Projects', name: 'reports', newName: 'quarterly' });

    expect(await countFor('favorites', 'path', 'Projects/reports/q1')).toBe(0);
    expect(await countFor('favorites', 'path', 'Projects/quarterly/q1')).toBe(2);
  });

  it('follows a moved folder', async () => {
    await setup();
    await givenBothUsersCareAbout('Projects/reports');

    const moved = await request(appFor({ id: 'alice', roles: ['admin'] }))
      .post('/api/files/move')
      .send({ items: [{ name: 'reports', path: 'Projects' }], destination: 'Archive' });
    expect(moved.status).toBe(200);

    expect(await countFor('favorites', 'path', 'Projects/reports')).toBe(0);
    expect(await countFor('favorites', 'path', 'Archive/reports')).toBe(2);
    expect(await countFor('folder_preferences', 'path', 'Archive/reports')).toBe(2);
  });

  it('leaves the original alone when a folder is copied', async () => {
    // A copy is a new folder that nobody has bookmarked yet; the original keeps
    // everything that pointed at it.
    await setup();
    await givenBothUsersCareAbout('Projects/reports');

    const copied = await request(appFor({ id: 'alice', roles: ['admin'] }))
      .post('/api/files/copy')
      .send({ items: [{ name: 'reports', path: 'Projects' }], destination: 'Archive' });
    expect(copied.status).toBe(200);

    expect(await countFor('favorites', 'path', 'Projects/reports')).toBe(2);
    expect(await countFor('favorites', 'path', 'Archive/reports')).toBe(0);
  });

  it('does not touch a folder whose name merely starts the same', async () => {
    // Deleting "Projects/reports" must not take "Projects/reports-archive"
    // with it — prefix matching without the separator would.
    await setup();
    await givenBothUsersCareAbout('Projects/reports');
    await givenBothUsersCareAbout('Projects/reports-archive');

    await request(appFor({ id: 'alice', roles: ['admin'] }))
      .delete('/api/files')
      .send({ items: [{ name: 'reports', path: 'Projects' }] });

    expect(await countFor('favorites', 'path', 'Projects/reports')).toBe(0);
    expect(await countFor('favorites', 'path', 'Projects/reports-archive')).toBe(2);
  });
});
