import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A deleted account's personal folder is not handed to the next account.
 *
 * Deleting an account removed its row and nothing else: `_users/<name>` stayed
 * on disk with what it held, its trash and its versions, and the name was free
 * again. With `USER_FOLDER_NAME_ORDER=username,id` — what the environment
 * reference recommends — the next account called bob claimed `bob`, and with it
 * the previous bob's files. Reproduced before this change.
 *
 * The name now stays reserved while the folder is on disk; removing or renaming
 * that folder on the server frees it. The rows that only described the account
 * go with it.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const build = async () => {
  envContext = await setupTestEnv({
    tag: 'personal-folder-reservation-',
    env: { USER_FOLDER_NAME_ORDER: 'username,id', USER_DIR_ENABLED: 'true' },
  });
  const dbModule = envContext.requireFresh('src/services/db');
  const db = await dbModule.getDb();
  const { claimPersonalFolderName } = envContext.requireFresh('src/services/personalFolders');
  const { deleteUser } = envContext.requireFresh('src/services/users/management');
  const userRoot = path.join(envContext.volumeDir, '_users');
  return { db, dbModule, claimPersonalFolderName, deleteUser, userRoot };
};

const addUser = (db, { id, username, createdAt = new Date().toISOString() }) => {
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
  ).run(id, `${id}@example.com`, username, username, createdAt, createdAt);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};

const count = (db, sql, ...args) =>
  db
    .prepare(sql)
    .pluck()
    .get(...args);

describe('the folder name of a deleted account', () => {
  it('is not given to the next account that derives it while its folder is on disk', async () => {
    const { db, claimPersonalFolderName, deleteUser, userRoot } = await build();
    expect(claimPersonalFolderName(db, addUser(db, { id: 'bob-1', username: 'bob' }))).toBe('bob');
    fs.mkdirSync(path.join(userRoot, 'bob'), { recursive: true });
    fs.writeFileSync(path.join(userRoot, 'bob', 'payslip.pdf'), 'private');

    await deleteUser({ userId: 'bob-1' });
    const claimed = claimPersonalFolderName(db, addUser(db, { id: 'bob-2', username: 'bob' }));

    expect(claimed).not.toBe('bob');
    expect(claimed).toBe('bob-2');
    expect(fs.readFileSync(path.join(userRoot, 'bob', 'payslip.pdf'), 'utf8')).toBe('private');
  });

  it('is given out again once its folder has been removed from the disk', async () => {
    const { db, claimPersonalFolderName, deleteUser, userRoot } = await build();
    claimPersonalFolderName(db, addUser(db, { id: 'bob-1', username: 'bob' }));
    fs.mkdirSync(path.join(userRoot, 'bob'), { recursive: true });
    await deleteUser({ userId: 'bob-1' });

    fs.rmSync(path.join(userRoot, 'bob'), { recursive: true });
    const claimed = claimPersonalFolderName(db, addUser(db, { id: 'bob-2', username: 'bob' }));

    expect(claimed).toBe('bob');
    expect(count(db, 'SELECT COUNT(*) FROM personal_folder_reservations')).toBe(0);
  });

  it('reserves nothing for an account that never had a folder name', async () => {
    const { db, deleteUser } = await build();
    addUser(db, { id: 'ann-1', username: 'ann' });

    await deleteUser({ userId: 'ann-1' });

    expect(count(db, 'SELECT COUNT(*) FROM personal_folder_reservations')).toBe(0);
  });
});

describe('deleting an account', () => {
  const seedRows = (db, userId) => {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO folder_preferences (user_id, path, sort_by, sort_order, view_mode, updated_at) VALUES (?, 'Docs', 'name', 'asc', 'list', ?)"
    ).run(userId, now);
    db.prepare(
      "INSERT INTO recent_destinations (user_id, path, used_at) VALUES (?, 'Docs', ?)"
    ).run(userId, now);
    db.prepare('INSERT INTO auth_locks (key, failed_count, locked_until) VALUES (?, 3, NULL)').run(
      userId
    );
  };

  it('removes the rows that only described it, and leaves everyone else their own', async () => {
    const { db, deleteUser } = await build();
    addUser(db, { id: 'gone', username: 'gone' });
    addUser(db, { id: 'stays', username: 'stays' });
    seedRows(db, 'gone');
    seedRows(db, 'stays');

    await deleteUser({ userId: 'gone' });

    for (const table of ['folder_preferences', 'recent_destinations']) {
      expect(count(db, `SELECT COUNT(*) FROM ${table} WHERE user_id = 'gone'`), table).toBe(0);
      expect(count(db, `SELECT COUNT(*) FROM ${table} WHERE user_id = 'stays'`), table).toBe(1);
    }
    expect(count(db, "SELECT COUNT(*) FROM auth_locks WHERE key = 'gone'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) FROM auth_locks WHERE key = 'stays'")).toBe(1);
  });

  it('removes, at the upgrade, the rows accounts deleted before it left behind', async () => {
    const { db, dbModule, deleteUser } = await build();
    addUser(db, { id: 'stays', username: 'stays' });
    addUser(db, { id: 'deleted-long-ago', username: 'old' });
    seedRows(db, 'stays');
    seedRows(db, 'deleted-long-ago');
    // Deleted the way every release before this one did: the row alone.
    db.prepare("DELETE FROM users WHERE id = 'deleted-long-ago'").run();
    db.prepare("UPDATE meta SET value = '19' WHERE key = 'schema_version'").run();
    dbModule.closeDb();
    void deleteUser;

    const reopened = await envContext.requireFresh('src/services/db').getDb();

    expect(count(reopened, "SELECT value FROM meta WHERE key = 'schema_version'")).toBe('20');
    for (const table of ['folder_preferences', 'recent_destinations']) {
      expect(
        count(reopened, `SELECT COUNT(*) FROM ${table} WHERE user_id = 'deleted-long-ago'`)
      ).toBe(0);
      expect(count(reopened, `SELECT COUNT(*) FROM ${table} WHERE user_id = 'stays'`)).toBe(1);
    }
    // Sign-in locks are left alone: those older releases wrote are keyed by the name
    // that was typed, not by an account id, so which account one belonged to
    // cannot be told, and an upgrade must not lift a lock it cannot place.
    expect(count(reopened, 'SELECT COUNT(*) FROM auth_locks')).toBe(2);
  });
});
