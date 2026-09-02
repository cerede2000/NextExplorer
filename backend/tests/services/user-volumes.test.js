import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Volumes handed to one account.
 *
 * This is how an administrator gives somebody a folder and nothing else, so the
 * validation is not paperwork — a reserved label collides with a route the
 * explorer already owns, and a duplicate label makes two different folders
 * answer to the same name in the sidebar, with only one of them reachable.
 *
 * It sat at 45%, and the half that was missing is every refusal.
 */

let ctx;

const setup = async () => {
  const envContext = await setupTestEnv({
    tag: 'user-volumes-test-',
    modules: ['src/services/db', 'src/services/userVolumesService'],
  });
  const service = envContext.requireFresh('src/services/userVolumesService');
  const { getDb } = envContext.requireFresh('src/services/db');
  const db = await getDb();
  const now = new Date().toISOString();
  for (const id of ['alice', 'bob']) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, `${id}@example.com`, 1, id, id, '["user"]', now, now);
  }
  const dirs = {};
  for (const name of ['media', 'archive', 'other']) {
    dirs[name] = path.join(envContext.tmpRoot, name);
    await fs.mkdir(dirs[name], { recursive: true });
  }
  ctx = { envContext, service, dirs, tmpRoot: envContext.tmpRoot };
  return ctx;
};

afterEach(async () => {
  if (ctx) {
    await ctx.envContext.cleanup();
    ctx = null;
  }
});

const rejection = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

describe('adding a volume', () => {
  it('stores it and hands back the client shape', async () => {
    const { service, dirs } = await setup();

    const volume = await service.addVolumeToUser({
      userId: 'alice',
      label: 'Media',
      volumePath: dirs.media,
    });

    expect(volume).toMatchObject({
      userId: 'alice',
      label: 'Media',
      path: dirs.media,
      accessMode: 'readwrite',
    });
    expect(volume.id).toBeTruthy();
    // The snake_case columns must not leak to a client.
    expect(volume).not.toHaveProperty('user_id');
  });

  it('accepts read-only', async () => {
    const { service, dirs } = await setup();

    const volume = await service.addVolumeToUser({
      userId: 'alice',
      label: 'Archive',
      volumePath: dirs.archive,
      accessMode: 'readonly',
    });

    expect(volume.accessMode).toBe('readonly');
  });

  it.each([
    ['no user', { userId: '', label: 'Media' }, 400],
    ['no label', { userId: 'alice', label: '   ' }, 400],
    ['a made-up access mode', { userId: 'alice', label: 'Media', accessMode: 'append' }, 400],
  ])('refuses %s', async (_label, overrides, status) => {
    const { service, dirs } = await setup();

    const error = await rejection(
      service.addVolumeToUser({ volumePath: dirs.media, ...overrides })
    );

    expect(error?.status).toBe(status);
  });

  /**
   * `personal`, `share` and `volumes` are paths the explorer already routes.
   * A volume answering to one of them shadows the real thing.
   */
  it.each(['personal', 'share', 'volumes', 'Personal', 'SHARE'])(
    'refuses the reserved label %s',
    async (label) => {
      const { service, dirs } = await setup();

      const error = await rejection(
        service.addVolumeToUser({ userId: 'alice', label, volumePath: dirs.media })
      );

      expect(error?.status).toBe(400);
      expect(String(error?.message)).toMatch(/reserved/i);
    }
  );

  it('refuses a path that is not there', async () => {
    const { service, tmpRoot } = await setup();

    const error = await rejection(
      service.addVolumeToUser({
        userId: 'alice',
        label: 'Ghost',
        volumePath: path.join(tmpRoot, 'nowhere'),
      })
    );

    expect(error?.status).toBe(400);
  });

  it('refuses a file where a directory was expected', async () => {
    const { service, tmpRoot } = await setup();
    const file = path.join(tmpRoot, 'notes.txt');
    await fs.writeFile(file, 'x');

    const error = await rejection(
      service.addVolumeToUser({ userId: 'alice', label: 'Notes', volumePath: file })
    );

    expect(error?.status).toBe(400);
    expect(String(error?.message)).toMatch(/directory/i);
  });

  it('refuses the same path twice for one person', async () => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'alice', label: 'Media', volumePath: dirs.media });

    const error = await rejection(
      service.addVolumeToUser({ userId: 'alice', label: 'Films', volumePath: dirs.media })
    );

    expect(error?.status).toBe(409);
  });

  it('refuses the same label twice for one person', async () => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'alice', label: 'Media', volumePath: dirs.media });

    const error = await rejection(
      service.addVolumeToUser({ userId: 'alice', label: 'Media', volumePath: dirs.archive })
    );

    expect(error?.status).toBe(409);
  });

  /** Both clashes are per-person. Two accounts naming their own folder Media is fine. */
  it('lets a second person reuse a label, and a path', async () => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'alice', label: 'Media', volumePath: dirs.media });

    const bob = await service.addVolumeToUser({
      userId: 'bob',
      label: 'Media',
      volumePath: dirs.media,
    });

    expect(bob.userId).toBe('bob');
  });

  it('trims the label rather than storing the spaces', async () => {
    const { service, dirs } = await setup();

    const volume = await service.addVolumeToUser({
      userId: 'alice',
      label: '  Media  ',
      volumePath: dirs.media,
    });

    expect(volume.label).toBe('Media');
  });
});

describe('listing and finding', () => {
  it('returns only that person’s volumes, ordered by label', async () => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'alice', label: 'Zulu', volumePath: dirs.media });
    await service.addVolumeToUser({ userId: 'alice', label: 'Alpha', volumePath: dirs.archive });
    await service.addVolumeToUser({ userId: 'bob', label: 'Bravo', volumePath: dirs.other });

    const volumes = await service.getVolumesForUser('alice');

    expect(volumes.map((v) => v.label)).toEqual(['Alpha', 'Zulu']);
  });

  it('answers with an empty list for somebody who has none', async () => {
    const { service } = await setup();

    expect(await service.getVolumesForUser('bob')).toEqual([]);
  });

  it('answers null for an id that is not there', async () => {
    const { service } = await setup();

    expect(await service.getVolumeById('no-such-volume')).toBeNull();
  });
});

describe('matching a path to a volume', () => {
  it('matches on the first segment, which is the label the UI shows', async () => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'alice', label: 'Media', volumePath: dirs.media });

    const found = await service.getUserVolumeForPath('alice', 'Media/Films/2026');

    expect(found?.label).toBe('Media');
  });

  it.each([
    ['leading slashes', '///Media/Films'],
    ['a trailing slash', 'Media/'],
  ])('normalises %s away first', async (_label, input) => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'alice', label: 'Media', volumePath: dirs.media });

    expect((await service.getUserVolumeForPath('alice', input))?.label).toBe('Media');
  });

  it('answers null for the root, which is no volume', async () => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'alice', label: 'Media', volumePath: dirs.media });

    expect(await service.getUserVolumeForPath('alice', '')).toBeNull();
    expect(await service.getUserVolumeForPath('alice', '/')).toBeNull();
  });

  /** Somebody else's volume is not yours, whatever it is called. */
  it('does not match a volume belonging to another person', async () => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'bob', label: 'Media', volumePath: dirs.media });

    expect(await service.getUserVolumeForPath('alice', 'Media/Films')).toBeNull();
  });

  it('matches the label exactly, not by prefix', async () => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'alice', label: 'Media', volumePath: dirs.media });

    expect(await service.getUserVolumeForPath('alice', 'MediaArchive/x')).toBeNull();
  });
});

describe('changing and removing', () => {
  it('renames a volume', async () => {
    const { service, dirs } = await setup();
    const volume = await service.addVolumeToUser({
      userId: 'alice',
      label: 'Media',
      volumePath: dirs.media,
    });

    const updated = await service.updateUserVolume(volume.id, { label: 'Films' });

    expect(updated.label).toBe('Films');
  });

  it('changes the access mode', async () => {
    const { service, dirs } = await setup();
    const volume = await service.addVolumeToUser({
      userId: 'alice',
      label: 'Media',
      volumePath: dirs.media,
    });

    const updated = await service.updateUserVolume(volume.id, { accessMode: 'readonly' });

    expect(updated.accessMode).toBe('readonly');
  });

  it('refuses a rename onto a label that person already uses', async () => {
    const { service, dirs } = await setup();
    await service.addVolumeToUser({ userId: 'alice', label: 'Media', volumePath: dirs.media });
    const second = await service.addVolumeToUser({
      userId: 'alice',
      label: 'Archive',
      volumePath: dirs.archive,
    });

    const error = await rejection(service.updateUserVolume(second.id, { label: 'Media' }));

    expect(error?.status).toBe(409);
  });

  it('refuses a rename onto a reserved label', async () => {
    const { service, dirs } = await setup();
    const volume = await service.addVolumeToUser({
      userId: 'alice',
      label: 'Media',
      volumePath: dirs.media,
    });

    const error = await rejection(service.updateUserVolume(volume.id, { label: 'share' }));

    expect(error?.status).toBe(400);
  });

  it.each([
    ['update', (s, id) => s.updateUserVolume(id, { label: 'X' })],
    ['remove', (s, id) => s.removeVolumeFromUser(id)],
  ])('answers 404 to %s on a volume that is gone', async (_label, act) => {
    const { service } = await setup();

    const error = await rejection(act(service, 'no-such-volume'));

    expect(error?.status).toBe(404);
  });

  it('removes a volume and leaves the others', async () => {
    const { service, dirs } = await setup();
    const media = await service.addVolumeToUser({
      userId: 'alice',
      label: 'Media',
      volumePath: dirs.media,
    });
    await service.addVolumeToUser({ userId: 'alice', label: 'Archive', volumePath: dirs.archive });

    expect(await service.removeVolumeFromUser(media.id)).toBe(true);
    expect((await service.getVolumesForUser('alice')).map((v) => v.label)).toEqual(['Archive']);
  });

  /** Removing the assignment must not remove what it points at. */
  it('leaves the folder on disk alone', async () => {
    const { service, dirs } = await setup();
    const volume = await service.addVolumeToUser({
      userId: 'alice',
      label: 'Media',
      volumePath: dirs.media,
    });

    await service.removeVolumeFromUser(volume.id);

    expect((await fs.stat(dirs.media)).isDirectory()).toBe(true);
  });
});
