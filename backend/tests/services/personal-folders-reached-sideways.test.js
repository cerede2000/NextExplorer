import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Somebody's personal folder, reached any way other than the personal space.
 *
 * Personal folders default to `<volume>/_users`, inside the tree everyone
 * browses. Resolving `_users/bob` through the volume has refused for a while;
 * asking whether it may be read did not, and the search asks exactly that of
 * paths it never resolves — the index reads the whole volume, and an ordinary
 * account searching it was offered another account's private files by name
 * and by what they said.
 *
 * The same folder can be reached from an assigned volume that holds it, and
 * from a share of one, and each of those needs the same answer.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const ALICE = { id: 'alice', roles: ['user'] };
const ADMIN = { id: 'admin', roles: ['admin'] };

const seed = async (env = {}) => {
  envContext = await setupTestEnv({
    tag: 'personal-sideways-',
    env: { USER_DIR_ENABLED: 'true', ...env },
  });
  const db = await envContext.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  for (const [id, roles] of [
    ['alice', '["user"]'],
    ['bob', '["user"]'],
    ['admin', '["admin"]'],
  ]) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(id, `${id}@example.com`, id, id, roles, now, now);
  }

  const volume = envContext.volumeDir;
  await fs.mkdir(path.join(volume, '_users', 'bob'), { recursive: true });
  await fs.writeFile(path.join(volume, '_users', 'bob', 'secret.txt'), 'x');
  await fs.mkdir(path.join(volume, 'Public'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Public', 'open.txt'), 'x');

  return envContext.requireFresh('src/services/accessManager');
};

describe('through the volume', () => {
  // An administrator as well: the volume's rules give an administrator
  // everything, and whose folder this is was never one of them.
  for (const [who, user] of [
    ['an ordinary account', ALICE],
    ['an administrator', ADMIN],
  ]) {
    it(`is refused to ${who}, by the check alone`, async () => {
      const accessManager = await seed();

      const open = await accessManager.getAccessInfo({ user }, 'Public/open.txt');
      expect(open.canAccess).toBe(true);

      for (const target of ['_users/bob', '_users/bob/secret.txt']) {
        const access = await accessManager.getAccessInfo({ user }, target);
        expect(access.canAccess).toBe(false);
        expect(access.denialReason).toMatch(/personal space/);
      }
    });
  }

  it('is still reached by its owner through the personal space', async () => {
    const accessManager = await seed();
    const access = await accessManager.getAccessInfo(
      { user: { id: 'bob', roles: ['user'] } },
      'personal/secret.txt'
    );
    expect(access.canAccess).toBe(true);
  });

  // `USER_ROOT` pointed at the volume itself: refusing there would refuse the
  // whole volume, which is a worse answer than the question.
  it('is not a rule at all when the personal root is the volume', async () => {
    envContext = await setupTestEnv({ tag: 'personal-root-is-volume-' });
    const previous = process.env.USER_ROOT;
    process.env.USER_ROOT = envContext.volumeDir;
    try {
      const { directories } = envContext.requireFresh('src/config/index');
      expect(directories.userRoot).toBe(envContext.volumeDir);
      await fs.mkdir(path.join(envContext.volumeDir, 'Public'), { recursive: true });

      const accessManager = envContext.requireFresh('src/services/accessManager');
      const access = await accessManager.getAccessInfo({ user: ADMIN }, 'Public');
      expect(access.canAccess).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.USER_ROOT;
      else process.env.USER_ROOT = previous;
    }
  });
});

describe('through an assigned volume that holds it', () => {
  const assignWholeVolume = async (target = envContext.volumeDir) => {
    const volumes = envContext.requireFresh('src/services/userVolumesService');
    return volumes.addVolumeToUser({ userId: 'alice', label: 'Tout', volumePath: target });
  };

  it('is refused by the check', async () => {
    const accessManager = await seed({ USER_VOLUMES: 'true' });
    await assignWholeVolume();

    const open = await accessManager.getAccessInfo({ user: ALICE }, 'Tout/Public/open.txt');
    expect(open.canAccess).toBe(true);

    const access = await accessManager.getAccessInfo({ user: ALICE }, 'Tout/_users/bob/secret.txt');
    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toMatch(/personal space/);
  });

  it('is refused by the resolution', async () => {
    await seed({ USER_VOLUMES: 'true' });
    const userVolume = await assignWholeVolume();
    const { resolveLogicalPath } = envContext.requireFresh('src/utils/pathUtils');

    await expect(
      resolveLogicalPath('Tout/Public', { user: ALICE, userVolume })
    ).resolves.toMatchObject({ absolutePath: path.join(envContext.volumeDir, 'Public') });
    await expect(
      resolveLogicalPath('Tout/_users/bob', { user: ALICE, userVolume })
    ).rejects.toThrow(/personal space/);
  });

  // An administrator who assigns an account its own personal folder as a
  // volume has not stepped into anything, and the account keeps its files.
  it('leaves alone a volume that is itself inside a personal folder', async () => {
    const accessManager = await seed({ USER_VOLUMES: 'true' });
    await assignWholeVolume(path.join(envContext.volumeDir, '_users', 'bob'));

    const access = await accessManager.getAccessInfo({ user: ALICE }, 'Tout/secret.txt');
    expect(access.canAccess).toBe(true);
  });
});

describe('through a share of such a volume', () => {
  it('does not resolve', async () => {
    await seed({ USER_VOLUMES: 'true' });
    const volumes = envContext.requireFresh('src/services/userVolumesService');
    const userVolume = await volumes.addVolumeToUser({
      userId: 'alice',
      label: 'Tout',
      volumePath: envContext.volumeDir,
    });
    const shares = envContext.requireFresh('src/services/sharesService');
    const { resolveLogicalPath } = envContext.requireFresh('src/utils/pathUtils');

    const shareOf = (sourcePath) =>
      shares.createShare({
        ownerId: 'alice',
        sourceSpace: 'user_volume',
        sourcePath,
        isDirectory: true,
        accessMode: 'readonly',
      });

    const open = await shareOf(`${userVolume.id}/Public`);
    await expect(resolveLogicalPath(`share/${open.shareToken}`)).resolves.toMatchObject({
      absolutePath: path.join(envContext.volumeDir, 'Public'),
    });

    const sideways = await shareOf(`${userVolume.id}/_users/bob`);
    await expect(resolveLogicalPath(`share/${sideways.shareToken}`)).rejects.toThrow(
      /personal space/
    );
  });

  // The search asks about paths inside a share without resolving them, the
  // same way it does for the volume.
  it('is refused by the check, below a share of the whole volume', async () => {
    const accessManager = await seed({ USER_VOLUMES: 'true' });
    const volumes = envContext.requireFresh('src/services/userVolumesService');
    const userVolume = await volumes.addVolumeToUser({
      userId: 'alice',
      label: 'Tout',
      volumePath: envContext.volumeDir,
    });
    const shares = envContext.requireFresh('src/services/sharesService');
    const context = { user: ALICE };

    const share = await shares.createShare({
      ownerId: 'alice',
      sourceSpace: 'user_volume',
      sourcePath: userVolume.id,
      isDirectory: true,
      accessMode: 'readonly',
    });

    const open = await accessManager.getShareAccess(context, share.shareToken, 'Public/open.txt');
    expect(open.canAccess).toBe(true);

    const sideways = await accessManager.getShareAccess(
      context,
      share.shareToken,
      '_users/bob/secret.txt'
    );
    expect(sideways.canAccess).toBe(false);
    expect(sideways.denialReason).toMatch(/personal space/);
  });
});

describe('through a share of a volume folder that holds them', () => {
  // `USER_ROOT=<volume>/Espace/homes`: a share of `Espace` is an ordinary
  // share of an ordinary folder, and it holds every account's files.
  it('is refused by the check', async () => {
    envContext = await setupTestEnv({ tag: 'personal-under-share-' });
    const previous = process.env.USER_ROOT;
    process.env.USER_ROOT = path.join(envContext.volumeDir, 'Espace', 'homes');
    try {
      const volume = envContext.volumeDir;
      await fs.mkdir(path.join(volume, 'Espace', 'homes', 'bob'), { recursive: true });
      await fs.mkdir(path.join(volume, 'Espace', 'Public'), { recursive: true });
      const db = await envContext.requireFresh('src/services/db').getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES ('alice', 'alice@example.com', 1, 'alice', 'alice', '["user"]', ?, ?)`
      ).run(now, now);

      const shares = envContext.requireFresh('src/services/sharesService');
      const accessManager = envContext.requireFresh('src/services/accessManager');
      const share = await shares.createShare({
        ownerId: 'alice',
        sourceSpace: 'volume',
        sourcePath: 'Espace',
        isDirectory: true,
        accessMode: 'readonly',
      });
      const context = { user: ALICE };

      const open = await accessManager.getShareAccess(context, share.shareToken, 'Public');
      expect(open.canAccess).toBe(true);

      const sideways = await accessManager.getShareAccess(context, share.shareToken, 'homes/bob');
      expect(sideways.canAccess).toBe(false);
      expect(sideways.denialReason).toMatch(/personal space/);
    } finally {
      if (previous === undefined) delete process.env.USER_ROOT;
      else process.env.USER_ROOT = previous;
    }
  });
});
