import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';
import { OTHER_DEVICE } from '../helpers/cross-device.js';

/**
 * Where the trash for a deleted path lives.
 *
 * One zone per space a file can be deleted from, found from the absolute path
 * alone — so a file reached through a volume, a user volume label or a share
 * link always lands in the same place — and a zone the maintenance only
 * touches when its marker proves it is the zone it expects.
 */

let envContext;
let zones;
let usersService;
let userVolumesService;

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'trash-zones-', env: { USER_VOLUMES: 'true' } });
  zones = envContext.requireFresh('src/services/trash/zones');
  usersService = envContext.requireFresh('src/services/users');
  userVolumesService = envContext.requireFresh('src/services/userVolumesService');
});

afterEach(async () => {
  await envContext.cleanup();
});

const volumePath = (...segments) => path.join(envContext.volumeDir, ...segments);

describe('locating the zone of a path', () => {
  it('is the volume for anything inside it, however deep', async () => {
    expect(await zones.locateZoneRoot(volumePath('Projects', 'notes.txt'))).toEqual({
      root: volumePath('Projects'),
    });
    expect(await zones.locateZoneRoot(volumePath('Projects', 'a', 'b', 'c.txt'))).toEqual({
      root: volumePath('Projects'),
    });
  });

  it('gives each volume its own zone', async () => {
    expect((await zones.locateZoneRoot(volumePath('Photos', 'x.jpg'))).root).toBe(
      volumePath('Photos')
    );
  });

  it('refuses a volume itself: it cannot go into its own trash', async () => {
    expect(await zones.locateZoneRoot(volumePath('Projects'))).toEqual({ reason: 'zone-root' });
  });

  it('refuses what is already in a zone', async () => {
    expect(
      await zones.locateZoneRoot(volumePath('Projects', '.nextexplorer', 'trash', 'abc'))
    ).toEqual({ reason: 'inside-zone' });
  });

  it('refuses a path no managed space contains', async () => {
    expect(await zones.locateZoneRoot(path.join(envContext.tmpRoot, 'elsewhere', 'x'))).toEqual({
      reason: 'no-zone',
    });
    expect(await zones.locateZoneRoot(envContext.volumeDir)).toEqual({ reason: 'no-zone' });
  });

  /** The personal root sits inside the volume root by default, and wins. */
  it('is the person’s own folder for a personal file', async () => {
    const personal = path.join(envContext.volumeDir, '_users', 'alice');

    expect(await zones.locateZoneRoot(path.join(personal, 'docs', 'cv.pdf'))).toEqual({
      root: personal,
    });
  });

  it('is the assigned volume for a path outside the volume root', async () => {
    const assigned = path.join(envContext.tmpRoot, 'assigned');
    await fs.mkdir(assigned, { recursive: true });
    const user = await usersService.createLocalUser({
      email: 'bob@example.com',
      username: 'bob',
      password: 'secret123',
      roles: ['user'],
    });
    await userVolumesService.addVolumeToUser({
      userId: user.id,
      label: 'Work',
      volumePath: assigned,
    });

    expect(await zones.locateZoneRoot(path.join(assigned, 'report.docx'))).toEqual({
      root: assigned,
    });
  });

  /** Two labels over nested folders still make one physical tree, and one zone. */
  it('is the outermost assigned volume when they nest', async () => {
    const outer = path.join(envContext.tmpRoot, 'data');
    const inner = path.join(outer, 'team');
    await fs.mkdir(inner, { recursive: true });
    const user = await usersService.createLocalUser({
      email: 'carol@example.com',
      username: 'carol',
      password: 'secret123',
      roles: ['user'],
    });
    await userVolumesService.addVolumeToUser({ userId: user.id, label: 'Team', volumePath: inner });
    await userVolumesService.addVolumeToUser({ userId: user.id, label: 'Data', volumePath: outer });

    expect(await zones.locateZoneRoot(path.join(inner, 'plan.txt'))).toEqual({ root: outer });
  });
});

describe('opening a zone', () => {
  it('creates the hidden directory, private to the application, with a marker', async () => {
    const root = volumePath('Projects');
    await fs.mkdir(root, { recursive: true });

    const zone = await zones.ensureZone(root);

    const marker = JSON.parse(await fs.readFile(zones.markerPath(root), 'utf8'));
    expect(marker.id).toBe(zone.id);
    expect(zone.trashDirectory).toBe(path.join(root, '.nextexplorer', 'trash'));
    const mode = (await fs.stat(zones.zoneDirectory(root))).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('opens the same zone every time', async () => {
    const root = volumePath('Projects');
    await fs.mkdir(root, { recursive: true });

    const first = await zones.ensureZone(root);
    const second = await zones.ensureZone(root);

    expect(second.id).toBe(first.id);
  });

  it('agrees on one zone when two deletions create it at once', async () => {
    const root = volumePath('Projects');
    await fs.mkdir(root, { recursive: true });

    const opened = await Promise.all(Array.from({ length: 8 }, () => zones.ensureZone(root)));

    expect(new Set(opened.map((zone) => zone.id)).size).toBe(1);
  });

  it('records the zone in the database', async () => {
    const root = volumePath('Projects');
    await fs.mkdir(root, { recursive: true });
    const zone = await zones.ensureZone(root);

    const { getDb } = envContext.requireFresh('src/services/db');
    const row = (await getDb()).prepare('SELECT root FROM trash_zones WHERE id = ?').get(zone.id);
    expect(row.root).toBe(root);
  });

  /** A database restored from an older backup: the zone on disk is taken back as itself. */
  it('takes back a zone the database has forgotten', async () => {
    const root = volumePath('Projects');
    await fs.mkdir(root, { recursive: true });
    const zone = await zones.ensureZone(root);
    const { getDb } = envContext.requireFresh('src/services/db');
    (await getDb()).prepare('DELETE FROM trash_zones').run();

    const reopened = await zones.ensureZone(root);

    expect(reopened.id).toBe(zone.id);
    const count = (await getDb()).prepare('SELECT COUNT(*) AS n FROM trash_zones').get().n;
    expect(count).toBe(1);
  });

  it('refuses a zone whose marker cannot be read, rather than replacing it', async () => {
    const root = volumePath('Projects');
    await fs.mkdir(zones.zoneDirectory(root), { recursive: true });
    await fs.writeFile(zones.markerPath(root), 'not json');

    await expect(zones.ensureZone(root)).rejects.toMatchObject({ code: 'TRASH_ZONE_UNREADABLE' });
    expect(await fs.readFile(zones.markerPath(root), 'utf8')).toBe('not json');
  });
});

describe('inspecting a known zone', () => {
  const openZone = async () => {
    const root = volumePath('Projects');
    await fs.mkdir(root, { recursive: true });
    return zones.ensureZone(root);
  };

  it('is available while its marker names it', async () => {
    const zone = await openZone();

    expect(await zones.inspectZone(zone)).toEqual({ available: true });
  });

  /** An unmounted disk leaves an empty mount point: indistinguishable from an emptied zone, so neither is touched. */
  it('is unavailable when the marker is gone', async () => {
    const zone = await openZone();
    await fs.rm(zones.zoneDirectory(zone.root), { recursive: true, force: true });

    expect(await zones.inspectZone(zone)).toEqual({ available: false, reason: 'missing' });
  });

  it('is unavailable when another zone’s marker has taken its place', async () => {
    const zone = await openZone();
    await fs.writeFile(zones.markerPath(zone.root), JSON.stringify({ id: 'someone-else' }));

    expect(await zones.inspectZone(zone)).toEqual({ available: false, reason: 'replaced' });
  });

  it('is unavailable when the marker is unreadable', async () => {
    const zone = await openZone();
    await fs.writeFile(zones.markerPath(zone.root), '{');

    expect(await zones.inspectZone(zone)).toEqual({ available: false, reason: 'unreadable' });
  });
});

describe('telling devices apart', () => {
  it('sees two paths of one filesystem as one device', async () => {
    await fs.mkdir(volumePath('Projects', 'a'), { recursive: true });
    await fs.mkdir(volumePath('Projects', 'b'), { recursive: true });

    expect(await zones.sameDevice(volumePath('Projects', 'a'), volumePath('Projects', 'b'))).toBe(
      true
    );
  });

  describe.skipIf(!OTHER_DEVICE)('with a real second device', () => {
    it('sees the temporary directory and the other device as two', async () => {
      expect(await zones.sameDevice(envContext.volumeDir, OTHER_DEVICE)).toBe(false);
    });
  });
});

describe('describing a zone', () => {
  it('names a volume, a personal folder and an assigned volume in their own terms', () => {
    expect(zones.describeZoneRoot(volumePath('Projects'))).toEqual({
      kind: 'volume',
      name: 'Projects',
    });
    expect(zones.describeZoneRoot(path.join(envContext.volumeDir, '_users', 'alice'))).toEqual({
      kind: 'personal',
      name: 'alice',
    });
    expect(zones.describeZoneRoot(path.join(envContext.tmpRoot, 'assigned'))).toEqual({
      kind: 'user-volume',
      name: 'assigned',
    });
  });
});
