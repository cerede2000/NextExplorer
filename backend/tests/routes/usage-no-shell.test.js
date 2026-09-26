import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';

import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * How full a volume is, asked of the kernel rather than of a shell.
 *
 * It used to be two commands with the path pasted into them — `du -sb "<path>"`
 * and `df -Pk "<path>"` — and a folder name is not a shell string. A folder
 * called `x";<anything>;echo "` closed the quote and left whatever followed for
 * the shell to run, as the server's user, the moment somebody opened it. Any
 * account that can make a folder could do it, and with sign-in switched off
 * that is anybody at all.
 *
 * `fs.statfs` answers the same question with no shell and no subprocess, which
 * is also why it is instant: `du` walked the whole tree to report a number the
 * filesystem already had.
 *
 * The test makes such a folder, asks for its usage, and checks that what the
 * name said to run did not run. It is written against the route because the
 * route is where the path arrived.
 */

describe('the usage of a folder whose name is shell syntax', () => {
  let env;
  let app;
  let witness;

  const NAME = 'wedge";touch $WITNESS;echo "';

  beforeEach(async () => {
    env = await setupTestEnv({ tag: 'usage-no-shell-', modules: ['src/routes/usage'] });
    witness = path.join(env.cacheDir, 'ran');
    process.env.WITNESS = witness;
    await fs.mkdir(path.join(env.volumeDir, NAME), { recursive: true });
    app = createTestApp({
      router: env.requireFresh('src/routes/usage'),
      mountPath: '/api',
      user: { id: 'u-1', roles: ['admin'] },
    });
  });

  afterEach(async () => {
    delete process.env.WITNESS;
    await env.cleanup();
  });

  const exists = async (file) =>
    fs
      .access(file)
      .then(() => true)
      .catch(() => false);

  it('does not run what the name says to run', async () => {
    expect(await exists(witness)).toBe(false);

    const response = await request(app).get(`/api/usage/${encodeURIComponent(NAME)}`);

    expect(response.status).toBe(200);
    expect(await exists(witness)).toBe(false);
  });

  it('answers with the numbers the filesystem holds', async () => {
    const response = await request(app).get('/api/usage/');

    expect(response.status).toBe(200);
    expect(response.body.total).toBeGreaterThan(0);
    expect(response.body.free).toBeGreaterThan(0);
    expect(response.body.used).toBe(response.body.total - response.body.free);
    expect(response.body.percentUsed).toBeGreaterThanOrEqual(0);
    expect(response.body.percentUsed).toBeLessThanOrEqual(100);
  });

  it('answers zeroes rather than failing when the path cannot be read', async () => {
    const response = await request(app).get('/api/usage/nothing-here');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ size: 0, free: 0, total: 0, percentUsed: 0 });
  });
});
