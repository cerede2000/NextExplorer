import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { setupTestEnv, createTestApp } from '../helpers/env-test-utils.js';

/**
 * A name from a request is not a shell string.
 *
 * Two routes built command lines with values from the request pasted into them and
 * handed the line to `/bin/sh`. A folder name, an owner, a group: anything that
 * closed the quoting left the rest for the shell to run, as the user this server
 * runs as. The folder one needs no privilege at all — any account that can make a
 * folder can name one, and with AUTH_ENABLED=false that is anybody who can reach
 * the server.
 *
 * The payloads below only create a file inside the test's own temporary directory,
 * and what each case asserts is that the file is not there.
 */

let env;

// Where a payload would land: a folder name cannot hold a slash, so it writes into
// the working directory of the process running this.
const PROOF = path.join(process.cwd(), 'a-shell-ran-here');
const shellRan = async () =>
  fs
    .access(PROOF)
    .then(() => true)
    .catch(() => false);

afterEach(async () => {
  // Whatever an assertion did, this happens: a run that does execute must not leave
  // the file behind for the next one to find.
  await fs.rm(PROOF, { force: true });
  if (env) {
    await env.cleanup();
    env = null;
  }
});

describe('asking how full a volume is', () => {
  it('does not run what a folder is called', async () => {
    env = await setupTestEnv({
      tag: 'usage-no-shell-',
      modules: ['src/routes/usage', 'src/services/accessManager', 'src/utils/pathUtils'],
    });

    // A name that closes the quoting the route used to open around it.
    const folder = 'Vol";touch a-shell-ran-here;echo "';
    await fs.mkdir(path.join(env.volumeDir, folder));

    const app = createTestApp({
      router: env.requireFresh('src/routes/usage'),
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
    });

    const response = await request(app).get(`/api/usage/${encodeURIComponent(folder)}`);

    expect(response.status).toBe(200);
    expect(await shellRan()).toBe(false);
  });
});

describe('changing an owner', () => {
  // With the error handler, so a refusal arrives as the sentence it is meant to be
  // rather than an empty body with a status on it.
  const appFor = () =>
    createTestApp({
      router: env.requireFresh('src/routes/permissions'),
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler: env.requireFresh('src/middleware/errorHandler').errorHandler,
    });

  const setup = async (tag) => {
    env = await setupTestEnv({
      tag,
      modules: [
        'src/routes/permissions',
        'src/middleware/errorHandler',
        'src/services/accessManager',
        'src/utils/pathUtils',
      ],
    });
    await fs.mkdir(path.join(env.volumeDir, 'Vol'), { recursive: true });
    await fs.writeFile(path.join(env.volumeDir, 'Vol', 'file.txt'), 'x');
  };

  it('does not run what an owner is called', async () => {
    await setup('chown-no-shell-');
    const response = await request(appFor())
      .post('/api/permissions/chown')
      .send({ path: 'Vol/file.txt', owner: 'root";touch a-shell-ran-here;echo "' });

    // Refused as a name, or attempted as one argument and failed — either way the
    // command inside it is not a command.
    expect(await shellRan()).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a name that would be read as an option', async () => {
    await setup('chown-option-');

    const response = await request(appFor())
      .post('/api/permissions/chown')
      .send({ path: 'Vol/file.txt', owner: '--reference=/etc/shadow' });

    // Refused as a name rather than attempted as one: a 400 from the route, and a
    // sentence that says which field and that it is a name. Not the exact wording —
    // a test that pins a sentence breaks when somebody improves it.
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/owner/i);
    expect(JSON.stringify(response.body)).toMatch(/(invalid|not a valid).{0,20}name/i);
  });
});
