import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * My Files, asked for the way a browser asks for it.
 *
 * The personal space had no test at this layer at all, and it shipped in a
 * release completely broken: `resolveLogicalPath` called the personal resolver
 * without awaiting it, so `pathExists` was handed a promise and every folder
 * came back "Path not found" — a directory that was right there, reported
 * missing.
 *
 * The containment tests kept passing throughout, because they call the resolver
 * directly, one layer below where the application resolves a path and one layer
 * below the defect. Nothing asked the question a person asks: open My Files and
 * see what is in it.
 *
 * Thirteen route files resolve paths this way. This covers the space rather
 * than the bug.
 */

let currentEnv;

const setup = async () => {
  const envContext = await setupTestEnv({
    tag: 'browse-personal-',
    env: { USER_DIR_ENABLED: 'true' },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/browse',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/services/settingsService',
      'src/utils/pathUtils',
    ],
  });
  currentEnv = envContext;

  const browseRoutes = envContext.requireFresh('src/routes/browse');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const { resolvePersonalPath } = envContext.requireFresh('src/utils/pathUtils');
  const { getDb } = envContext.requireFresh('src/services/db');

  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('alice', 'alice@example.com', 1, 'alice', 'Alice', '["user"]', now, now);

  const user = { id: 'alice', username: 'alice', roles: ['user'] };
  const userRoot = await resolvePersonalPath('', user);
  await fs.mkdir(userRoot, { recursive: true });

  const app = createTestApp({
    router: browseRoutes,
    mountPath: '/api',
    user,
    errorHandler,
  });

  return { app, userRoot, envContext };
};

const browse = (app, at = '') => request(app).get(`/api/browse/personal${at ? `/${at}` : ''}`);

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

describe('opening My Files', () => {
  it('answers', async () => {
    const { app } = await setup();

    const response = await browse(app);

    expect(response.status).toBe(200);
  });

  it('lists what is in it', async () => {
    const { app, userRoot } = await setup();
    await fs.writeFile(path.join(userRoot, 'notes.txt'), 'mine');

    const response = await browse(app);

    expect((response.body.items || []).map((item) => item.name)).toContain('notes.txt');
  });

  it('opens a folder inside it', async () => {
    const { app, userRoot } = await setup();
    await fs.mkdir(path.join(userRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(userRoot, 'docs', 'report.txt'), 'inside');

    const response = await browse(app, 'docs');

    expect(response.status).toBe(200);
    expect((response.body.items || []).map((item) => item.name)).toContain('report.txt');
  });

  /**
   * The symptom as it was reported: a directory that exists and is readable,
   * answered "Path not found".
   */
  it('does not call a folder that is there missing', async () => {
    const { app, userRoot } = await setup();
    await fs.mkdir(path.join(userRoot, 'docs'), { recursive: true });

    const response = await browse(app, 'docs');

    expect(response.status).not.toBe(404);
  });

  it('still says so for a folder that really is not there', async () => {
    const { app } = await setup();

    const response = await browse(app, 'no-such-folder');

    expect(response.status).toBe(404);
  });
});

describe('the edges of My Files', () => {
  /**
   * One person's space is not another's. The route resolves the folder from the
   * signed-in user, never from the path, so there is nothing here to aim
   * elsewhere — which is what this pins.
   */
  it('refuses a path that climbs out of it', async () => {
    const { app } = await setup();

    const response = await browse(app, '../../etc');

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  /**
   * And a symbolic link is the other way out. The check that catches it lives
   * in the resolver's promise, which is exactly what went unawaited: the
   * refusal resolved without complaint and its rejection ended the process
   * rather than the request.
   */
  it('refuses a symbolic link that leads out of it', async () => {
    const { app, userRoot, envContext } = await setup();
    const outside = path.join(envContext.tmpRoot, 'outside-personal-route');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await fs.symlink(outside, path.join(userRoot, 'escape'));

    const response = await browse(app, 'escape');

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).not.toContain('secret.txt');
  });

  /** Refused as a request, which means the answer arrives at all. */
  it('answers the refusal instead of failing to answer', async () => {
    const { app, userRoot, envContext } = await setup();
    const outside = path.join(envContext.tmpRoot, 'outside-answered');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(userRoot, 'escape'));

    const response = await browse(app, 'escape');

    expect(response.status).toBeLessThan(500);
  });
});
