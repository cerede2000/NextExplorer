import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Renaming is one of the two paths that write to disk after authorising, and
 * neither had a test. Reading it found nothing wrong — the parent, the item,
 * the new name and the target are each checked, in that order — which is
 * exactly the kind of code where a regression is silent.
 */

let envContext;
let renameEntry;
let context;
let plainContext;

const volumePath = (...parts) => path.join(envContext.volumeDir, ...parts);

const exists = async (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'rename-entry-' });
  ({ renameEntry } = envContext.requireFresh('src/services/renameService'));

  const dbService = envContext.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, '["admin"]', ?, ?)`
  ).run('admin-1', 'admin@example.com', 'admin', 'Admin', now, now);

  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
  ).run('user-1', 'user@example.com', 'user', 'User', now, now);

  context = { user: { id: 'admin-1', email: 'admin@example.com', roles: ['admin'] } };
  plainContext = { user: { id: 'user-1', email: 'user@example.com', roles: ['user'] } };

  await fs.mkdir(volumePath('Documents'), { recursive: true });
  await fs.writeFile(volumePath('Documents', 'report.txt'), 'contents');
});

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('renaming an entry', () => {
  it('moves it and says where it ended up', async () => {
    const result = await renameEntry({
      context,
      parentRelative: 'Documents',
      currentName: 'report.txt',
      newName: 'summary.txt',
    });

    expect(result.changed).toBe(true);
    expect(result.name).toBe('summary.txt');
    expect(result.relativePath).toBe('Documents/summary.txt');
    expect(result.previousAbsolutePath).toBe(volumePath('Documents', 'report.txt'));
    expect(await exists(volumePath('Documents', 'summary.txt'))).toBe(true);
    expect(await exists(volumePath('Documents', 'report.txt'))).toBe(false);
    expect(await fs.readFile(volumePath('Documents', 'summary.txt'), 'utf8')).toBe('contents');
  });

  // The editor renames the document it has open, and needs to know whether
  // anything moved so it can keep its session pointing at the file.
  it('treats renaming to the same name as nothing to do', async () => {
    const result = await renameEntry({
      context,
      parentRelative: 'Documents',
      currentName: 'report.txt',
      newName: 'report.txt',
    });

    expect(result.changed).toBe(false);
    expect(result.name).toBe('report.txt');
    expect(await exists(volumePath('Documents', 'report.txt'))).toBe(true);
  });

  it('refuses a name that is already taken', async () => {
    await fs.writeFile(volumePath('Documents', 'taken.txt'), 'someone else');

    await expect(
      renameEntry({
        context,
        parentRelative: 'Documents',
        currentName: 'report.txt',
        newName: 'taken.txt',
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    // Neither file moved.
    expect(await fs.readFile(volumePath('Documents', 'taken.txt'), 'utf8')).toBe('someone else');
    expect(await exists(volumePath('Documents', 'report.txt'))).toBe(true);
  });

  // A name with a separator in it is the caller's mistake, not the server's.
  // Answering 500 sent everyone looking in the wrong place, the logs included.
  it('answers a name with a path in it as a bad request', async () => {
    for (const newName of ['../escape.txt', 'sub/report.txt', '..']) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        renameEntry({
          context,
          parentRelative: 'Documents',
          currentName: 'report.txt',
          newName,
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    }

    expect(await exists(volumePath('Documents', 'report.txt'))).toBe(true);
  });

  it('refuses an empty or missing name', async () => {
    for (const newName of ['', null, undefined, 42]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        renameEntry({
          context,
          parentRelative: 'Documents',
          currentName: 'report.txt',
          newName,
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('refuses when the original name is missing', async () => {
    await expect(
      renameEntry({ context, parentRelative: 'Documents', currentName: '', newName: 'a.txt' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('says so when there is nothing to rename', async () => {
    await expect(
      renameEntry({
        context,
        parentRelative: 'Documents',
        currentName: 'not-here.txt',
        newName: 'anything.txt',
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('renames a folder with everything in it', async () => {
    await fs.mkdir(volumePath('Documents', 'Project', 'inner'), { recursive: true });
    await fs.writeFile(volumePath('Documents', 'Project', 'inner', 'deep.txt'), 'deep');

    const result = await renameEntry({
      context,
      parentRelative: 'Documents',
      currentName: 'Project',
      newName: 'Archive',
    });

    expect(result.changed).toBe(true);
    expect(await fs.readFile(volumePath('Documents', 'Archive', 'inner', 'deep.txt'), 'utf8')).toBe(
      'deep'
    );
  });
});

describe('what a rename must not walk past', () => {
  const readOnly = async (relativePath, { recursive = true } = {}) => {
    const accessControl = envContext.requireFresh('src/services/accessControlService');
    await accessControl.setRules([{ path: relativePath, permissions: 'ro', recursive }]);
  };

  // An administrator passes through a read-only rule on purpose — they are the
  // one who set it. Everyone else is stopped by it.
  it('refuses to rename inside a read-only folder', async () => {
    await readOnly('Documents');

    await expect(
      renameEntry({
        context: plainContext,
        parentRelative: 'Documents',
        currentName: 'report.txt',
        newName: 'summary.txt',
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await exists(volumePath('Documents', 'report.txt'))).toBe(true);
    expect(await exists(volumePath('Documents', 'summary.txt'))).toBe(false);
  });

  // Renaming is a write to the folder as much as to the item: the name lives
  // in the directory. A rule that covers the folder alone still stops it, and
  // it is the only case where the item's own permission would say yes.
  it('refuses when only the folder itself is read-only', async () => {
    await readOnly('Documents', { recursive: false });

    await expect(
      renameEntry({
        context: plainContext,
        parentRelative: 'Documents',
        currentName: 'report.txt',
        newName: 'summary.txt',
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await exists(volumePath('Documents', 'report.txt'))).toBe(true);
  });

  // The name being taken is checked too, not only the one being left. A rule
  // can name a single path, and renaming *into* it is a write to it.
  it('refuses when the name it would take is read-only', async () => {
    await readOnly('Documents/summary.txt', { recursive: false });

    await expect(
      renameEntry({
        context: plainContext,
        parentRelative: 'Documents',
        currentName: 'report.txt',
        newName: 'summary.txt',
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await exists(volumePath('Documents', 'report.txt'))).toBe(true);
    expect(await exists(volumePath('Documents', 'summary.txt'))).toBe(false);
  });
});

describe('what follows a renamed folder', () => {
  it('takes its favourites with it', async () => {
    await fs.mkdir(volumePath('Documents', 'Project'), { recursive: true });

    const favorites = envContext.requireFresh('src/services/favoritesService');
    await favorites.addFavorite('admin-1', {
      path: 'Documents/Project',
      label: 'Project',
    });

    await renameEntry({
      context,
      parentRelative: 'Documents',
      currentName: 'Project',
      newName: 'Archive',
    });

    const after = await favorites.getFavorites('admin-1');
    expect(after.map((entry) => entry.path)).toContain('Documents/Archive');
    expect(after.map((entry) => entry.path)).not.toContain('Documents/Project');
  });
});
