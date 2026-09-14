import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The trash zone is not a place anyone browses to.
 *
 * It holds what people deleted, under opaque ids, and the trash decides who
 * sees which item. A path typed into the address bar — or into a share, a
 * download, a preview — would walk around that, so no logical path through
 * the zone resolves, no listing shows it whatever the hidden-file settings,
 * and nothing can be named after it.
 */

let envContext;

beforeEach(async () => {
  envContext = await setupTestEnv({
    tag: 'zone-path-guard-',
    env: { HIDDEN_FILE_PATTERNS: '@' },
  });
  await fs.mkdir(path.join(envContext.volumeDir, 'Projects', '.nextexplorer', 'trash'), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(envContext.volumeDir, 'Projects', '.nextexplorer', 'trash', 'secret.txt'),
    'deleted by someone else'
  );
  await fs.writeFile(path.join(envContext.volumeDir, 'Projects', 'visible.txt'), 'hello');
});

afterEach(async () => {
  await envContext.cleanup();
});

describe('resolving a path through the zone', () => {
  it('is refused for a volume path', async () => {
    const { resolveLogicalPath } = envContext.requireFresh('src/utils/pathUtils');

    await expect(
      resolveLogicalPath('Projects/.nextexplorer/trash/secret.txt')
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('is refused however the path is spelled', async () => {
    const { resolveLogicalPath } = envContext.requireFresh('src/utils/pathUtils');

    await expect(resolveLogicalPath('volumes/Projects/.nextexplorer')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(resolveLogicalPath('Projects/sub/../.nextexplorer/trash')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('is refused for a personal path', async () => {
    const { resolvePersonalPath } = envContext.requireFresh('src/utils/pathUtils');

    await expect(
      resolvePersonalPath('.nextexplorer/trash', { id: 'u1', username: 'alice' })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('still resolves an ordinary path beside it', async () => {
    const { resolveLogicalPath } = envContext.requireFresh('src/utils/pathUtils');

    const resolved = await resolveLogicalPath('Projects/visible.txt');

    expect(resolved.absolutePath).toBe(path.join(envContext.volumeDir, 'Projects', 'visible.txt'));
  });

  /** A name that merely contains the word is somebody's file, not the zone. */
  it('does not refuse a name that only resembles it', async () => {
    const { resolveLogicalPath } = envContext.requireFresh('src/utils/pathUtils');

    await expect(resolveLogicalPath('Projects/.nextexplorer-old/x')).resolves.toBeTruthy();
    await expect(resolveLogicalPath('Projects/my.nextexplorer')).resolves.toBeTruthy();
  });
});

describe('naming something after the zone', () => {
  it('is refused', () => {
    const { ensureValidName } = envContext.requireFresh('src/utils/pathUtils');

    expect(() => ensureValidName('.nextexplorer')).toThrow(/not allowed/);
    expect(ensureValidName('.nextexplorer2')).toBe('.nextexplorer2');
  });
});

describe('listing a volume', () => {
  const buildBrowseApp = async () => {
    const browseRoutes = envContext.requireFresh('src/routes/browse');
    const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
    const { getDb } = envContext.requireFresh('src/services/db');
    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', now, now);
    return createTestApp({
      router: browseRoutes,
      mountPath: '/api',
      user: { id: 'admin', roles: ['admin'] },
      errorHandler,
    });
  };

  /** Hidden files here are only those starting with @: a dot-name would otherwise show. */
  it('never shows the zone, even when dot-names are not hidden', async () => {
    const app = await buildBrowseApp();

    const response = await request(app).get('/api/browse/Projects');

    expect(response.status).toBe(200);
    const names = response.body.items.map((item) => item.name);
    expect(names).toContain('visible.txt');
    expect(names).not.toContain('.nextexplorer');
  });

  /**
   * Browsing answers 404 for every path it will not resolve, a refusal
   * included — it does not say whether something is there. What matters is
   * that the zone's content never comes back.
   */
  it('refuses to list the zone by its path', async () => {
    const app = await buildBrowseApp();

    const response = await request(app).get('/api/browse/Projects/.nextexplorer/trash');

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('secret.txt');
  });
});
