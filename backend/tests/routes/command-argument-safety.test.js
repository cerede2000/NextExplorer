import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Regression tests for user input that reaches an external command.
 *
 * Search terms, account names and file paths are handed to ripgrep, chmod and
 * chown. They must always stay operands: a value starting with "-" must never
 * be read as an option (ripgrep's --pre runs an arbitrary command per file),
 * and nothing may be interpolated into a shell string.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const createSearchApp = async () => {
  const envContext = await setupTestEnv({
    tag: 'search-argument-safety-',
    env: { SEARCH_RIPGREP: 'true' },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/search',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/services/settingsService',
    ],
  });

  const searchRoutes = envContext.requireFresh('src/routes/search');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = createTestApp({
    router: searchRoutes,
    mountPath: '/api',
    user: { id: 'admin', roles: ['admin'] },
    errorHandler,
  });

  return { envContext, app };
};

describe('Search term argument safety', () => {
  it('treats a term starting with a dash as a literal pattern, not a ripgrep option', async () => {
    const { envContext, app } = await createSearchApp();
    currentEnv = envContext;

    // The needle is also a valid ripgrep flag. Without the `--` separator the
    // process would consume it as an option instead of searching for it.
    await fs.writeFile(
      path.join(envContext.volumeDir, 'flagged-content.txt'),
      'config: --pre=whoami\n'
    );
    await fs.writeFile(path.join(envContext.volumeDir, 'other.txt'), 'nothing to see\n');

    const response = await request(app).get('/api/search').query({ q: '--pre=whoami' });

    expect(response.status).toBe(200);
    const names = (response.body.items || []).map((item) => item.name);
    expect(names).toContain('flagged-content.txt');
    expect(names).not.toContain('other.txt');
  });
});

const createPermissionsApp = async () => {
  const envContext = await setupTestEnv({
    tag: 'permissions-argument-safety-',
    modules: [
      'src/config/env',
      'src/config/index',
      'src/utils/pathUtils',
      'src/routes/permissions',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/services/authorizationService',
      'src/services/settingsService',
    ],
  });

  const permissionsRoutes = envContext.requireFresh('src/routes/permissions');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = createTestApp({
    router: permissionsRoutes,
    mountPath: '/api',
    user: { id: 'admin', roles: ['admin'] },
    errorHandler,
  });

  return { envContext, app };
};

describe('Ownership change input validation', () => {
  it('rejects owner and group names that are not plain account names', async () => {
    const { envContext, app } = await createPermissionsApp();
    currentEnv = envContext;

    await fs.writeFile(path.join(envContext.volumeDir, 'target.txt'), 'content');

    const injected = await request(app)
      .post('/api/permissions/chown')
      .send({ path: 'target.txt', owner: 'root"; id > /tmp/pwned; echo "' });
    expect(injected.status).toBe(400);

    const optionLike = await request(app)
      .post('/api/permissions/chown')
      .send({ path: 'target.txt', group: '--reference=/etc/shadow' });
    expect(optionLike.status).toBe(400);

    const substituted = await request(app)
      .post('/api/permissions/chown')
      .send({ path: 'target.txt', owner: '$(whoami)' });
    expect(substituted.status).toBe(400);

    // The file must be untouched by the rejected attempts.
    await expect(fs.readFile(path.join(envContext.volumeDir, 'target.txt'), 'utf-8')).resolves.toBe(
      'content'
    );
  });

  it('accepts a well-formed account name', async () => {
    const { envContext, app } = await createPermissionsApp();
    currentEnv = envContext;

    await fs.writeFile(path.join(envContext.volumeDir, 'valid.txt'), 'content');

    const response = await request(app)
      .post('/api/permissions/chown')
      .send({ path: 'valid.txt', owner: 'appuser' });

    // Changing ownership needs privileges we do not have in CI, so the request
    // is allowed through validation and fails later (403) instead of 400.
    expect(response.status).not.toBe(400);
  });
});

describe('Recursive chmod argument safety', () => {
  it('applies permissions to a directory whose name contains shell metacharacters', async () => {
    const { envContext, app } = await createPermissionsApp();
    currentEnv = envContext;

    // Names like this can exist on a mounted host volume even though the app
    // would not create them itself.
    const trickyName = 'dir";id;#';
    const trickyDir = path.join(envContext.volumeDir, trickyName);
    await fs.mkdir(trickyDir, { recursive: true });
    await fs.writeFile(path.join(trickyDir, 'child.txt'), 'child');

    const response = await request(app)
      .post('/api/permissions/chmod')
      .send({ path: trickyName, mode: '755', recursive: true });

    expect(response.status).toBe(200);
    const childStats = await fs.stat(path.join(trickyDir, 'child.txt'));
    expect(childStats.mode & 0o777).toBe(0o755);
  });
});
