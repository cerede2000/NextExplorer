import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTestEnv } from '../helpers/env-test-utils.js';

const MODULES = [
  'src/config/env',
  'src/config/index',
  'src/services/db',
  'src/services/pathBindingsService',
  'src/services/orphanedBindingsService',
  'src/utils/pathUtils',
];

let envContext;

const build = async ({ env = {} } = {}) => {
  envContext = await setupTestEnv({ tag: 'orphaned-bindings-test-', modules: MODULES, env });
  const service = envContext.requireFresh('src/services/orphanedBindingsService');
  const dbService = envContext.requireFresh('src/services/db');
  const db = await dbService.getDb();

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('user-1', 'user-1@example.com', 1, 'user-1', 'User 1', '["user"]', now, now);

  return { service, db };
};

const addFavourite = (db, id, storedPath) =>
  db
    .prepare(
      `INSERT INTO favorites (id, user_id, path, label, position, created_at, updated_at)
       VALUES (?, 'user-1', ?, ?, 0, datetime('now'), datetime('now'))`
    )
    .run(id, storedPath, path.basename(storedPath) || storedPath);

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('reporting paths that point at a volume which is not there', () => {
  it('says nothing when every volume is present', async () => {
    const { service, db } = await build();
    await fs.mkdir(path.join(envContext.volumeDir, 'Documents'), { recursive: true });
    addFavourite(db, 'fav-1', 'Documents/Reports');

    expect(await service.findOrphanedBindings()).toEqual([]);
  });

  it('reports a volume that is gone, and counts what points at it', async () => {
    const { service, db } = await build();
    await fs.mkdir(path.join(envContext.volumeDir, 'Documents'), { recursive: true });
    addFavourite(db, 'fav-1', 'Documents/Reports');
    addFavourite(db, 'fav-2', 'OldNAS/Photos');
    addFavourite(db, 'fav-3', 'OldNAS/Videos');

    const orphaned = await service.findOrphanedBindings();

    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].volume).toBe('OldNAS');
    expect(orphaned[0].total).toBe(2);
    expect(orphaned[0].tables.favorites).toBe(2);
  });

  // The check must never remove anything: an unmounted volume looks exactly
  // like a deleted one, and deleting on that basis would be irreversible.
  it('removes nothing it reports', async () => {
    const { service, db } = await build();
    addFavourite(db, 'fav-1', 'OldNAS/Photos');

    await service.findOrphanedBindings();
    await service.reportOrphanedBindings();

    expect(db.prepare('SELECT COUNT(*) AS count FROM favorites').get().count).toBe(1);
  });

  // A per-user volume is addressed by its label, not by a directory under the
  // volume root. Without that, every one of them would look missing.
  it('accepts a per-user volume by its label', async () => {
    const { service, db } = await build();
    db.prepare(
      `INSERT INTO user_volumes (id, user_id, label, path, access_mode, created_at, updated_at)
       VALUES ('vol-1', 'user-1', 'MyNAS', '/elsewhere/nas', 'readwrite', datetime('now'), datetime('now'))`
    ).run();
    addFavourite(db, 'fav-1', 'MyNAS/Photos');

    expect(await service.findOrphanedBindings()).toEqual([]);
  });

  // A share token names a space of its own, not a volume.
  it('leaves a share path alone', async () => {
    const { service, db } = await build();
    addFavourite(db, 'fav-1', 'share/abc123/Inner');

    expect(await service.findOrphanedBindings()).toEqual([]);
  });

  it('leaves a personal-folder path alone where personal folders are enabled', async () => {
    const { service, db } = await build({ env: { USER_DIR_ENABLED: 'true' } });
    addFavourite(db, 'fav-1', 'personal/Notes');

    expect(await service.findOrphanedBindings()).toEqual([]);
  });

  // With personal folders switched off, `personal` is an ordinary volume name
  // and a path under it really does point at a volume that is not there.
  it('treats personal as a volume name where personal folders are off', async () => {
    const { service, db } = await build({ env: { USER_DIR_ENABLED: 'false' } });
    addFavourite(db, 'fav-1', 'personal/Notes');

    const orphaned = await service.findOrphanedBindings();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].volume).toBe('personal');
  });

  it('reports nothing when there is nothing stored', async () => {
    const { service } = await build();

    expect(await service.findOrphanedBindings()).toEqual([]);
  });

  // An unreadable volume root would make every stored path look orphaned.
  // Saying nothing beats crying wolf about all of them at once.
  it('stays silent when the volume root cannot be read', async () => {
    const { service, db } = await build();
    addFavourite(db, 'fav-1', 'Documents/Reports');
    await fs.rm(envContext.volumeDir, { recursive: true, force: true });

    expect(await service.findOrphanedBindings()).toBeNull();
  });
});
