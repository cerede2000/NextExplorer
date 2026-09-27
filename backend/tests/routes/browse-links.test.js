import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';

import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Symbolic links in a listing.
 *
 * Releases 1.1.8 to 2.0.2 left links in the old cache directory pointing at the
 * files moved to /config. Where that directory sits inside a volume, it lists
 * them — and the listing followed each one, showing the size and type of a file
 * outside the volume, on a row where renaming, deleting and opening were all
 * refused with "Resolved path is outside the configured volume root". The
 * refusal is right; the row was not. A link that leaves the volume is listed as
 * a link, and nothing about what it points at is read to describe it.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const setup = async ({ danglingInside = false } = {}) => {
  currentEnv = await setupTestEnv({ tag: 'browse-links-' });
  const browseRoutes = currentEnv.requireFresh('src/routes/browse');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
  ).run(now, now);
  const app = createTestApp({
    router: browseRoutes,
    mountPath: '/api',
    user: { id: 'admin', roles: ['admin'] },
    errorHandler,
  });

  const volume = currentEnv.volumeDir;
  const outside = path.join(currentEnv.tmpRoot, 'config-outside');
  await fs.mkdir(path.join(outside, 'extensions'), { recursive: true });
  // A size nothing inside the volume has, so it can only have been read there.
  await fs.writeFile(path.join(outside, 'app-config.json'), 'x'.repeat(4242));
  await fs.writeFile(path.join(outside, 'photo.jpg'), 'not really a photo');

  await fs.writeFile(path.join(volume, 'real.txt'), 'twelve bytes');
  await fs.symlink(path.join(volume, 'real.txt'), path.join(volume, 'shortcut.txt'));
  await fs.symlink(path.join(outside, 'app-config.json'), path.join(volume, 'app-config.json'));
  await fs.symlink(path.join(outside, 'extensions'), path.join(volume, 'extensions'));
  await fs.symlink(path.join(outside, 'photo.jpg'), path.join(volume, 'photo.jpg'));
  await fs.symlink(path.join(outside, 'gone.txt'), path.join(volume, 'dangling.txt'));
  if (danglingInside) {
    await fs.symlink(path.join(volume, 'never-there.txt'), path.join(volume, 'nowhere.txt'));
  }

  const response = await request(app).get('/api/browse/');
  expect(response.status).toBe(200);
  const byName = Object.fromEntries(response.body.items.map((item) => [item.name, item]));
  return { byName };
};

describe('a symbolic link in a listing', () => {
  it('that leaves the volume is listed as a link, with nothing read from what it points at', async () => {
    const { byName } = await setup();

    expect(byName['app-config.json']).toMatchObject({ link: 'outside', size: null, kind: 'json' });
    expect(byName.extensions).toMatchObject({ link: 'outside', size: null });
    expect(byName.extensions.kind).not.toBe('directory');
  });

  it('that leaves the volume offers no thumbnail of what it points at', async () => {
    const { byName } = await setup();

    expect(byName['photo.jpg']).toMatchObject({ link: 'outside' });
    expect(byName['photo.jpg'].supportsThumbnail).toBeUndefined();
  });

  it('that stays inside the volume is listed as what it points at, as before', async () => {
    const { byName } = await setup();

    expect(byName['shortcut.txt'].link).toBeUndefined();
    expect(byName['shortcut.txt']).toMatchObject({ kind: 'txt', size: 'twelve bytes'.length });
    expect(byName['real.txt']).toMatchObject({ kind: 'txt', size: 'twelve bytes'.length });
  });

  it('that leads nowhere outside the volume is still a link out of it, and says so', async () => {
    const { byName } = await setup();

    // An old link to a file /config no longer holds: nothing to open, but the
    // row is there on disk, and hiding it left nobody able to see why.
    expect(byName['dangling.txt']).toMatchObject({ link: 'outside', size: null });
  });

  it('that leads nowhere inside the volume is left out, as before', async () => {
    const { byName } = await setup({ danglingInside: true });

    expect(byName['nowhere.txt']).toBeUndefined();
  });
});
