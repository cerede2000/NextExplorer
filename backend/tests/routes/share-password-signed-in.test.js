import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A password-protected link, opened by somebody who is signed in.
 *
 * Being authenticated is not knowing the password. The check was "is there a
 * user or a guest session", so any account on the instance opening a
 * protected link walked straight past the prompt its owner had set up — the
 * share's contents, its direct file links, all of it.
 *
 * Fixing that alone would have locked such an account out for good: the
 * authentication middleware dropped the guest session as soon as a user was
 * attached, and the guest session is the proof the password was typed. So the
 * whole way through is run here, on the real application with real sessions:
 * asked, refused, the password given, let in — and still allowed to do what
 * the account may do anywhere else, the guest session beside it or not.
 */

const OWNER = { email: 'owner@example.com', username: 'owner', password: 'owner-secret-1' };
const BOB = { email: 'bob@example.com', username: 'bob', password: 'bob-secret-1' };
const SHARE_PASSWORD = 'open-sesame';

let envContext;
let app;
let owner;
let bob;
let token;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'share-password-signed-in-',
    env: { AUTH_ENABLED: 'true' },
  });
  const { createApp } = envContext.requireFresh('src/app');
  app = await createApp({ skipOidc: true, skipStaticFiles: true });

  await fs.mkdir(path.join(envContext.volumeDir, 'Projects', 'Report'), { recursive: true });
  await fs.writeFile(path.join(envContext.volumeDir, 'Projects', 'Report', 'plan.txt'), 'plan');
  await fs.mkdir(path.join(envContext.volumeDir, 'Bob'), { recursive: true });
  await fs.writeFile(path.join(envContext.volumeDir, 'Bob', 'notes.txt'), 'notes');

  owner = request.agent(app);
  expect((await owner.post('/api/auth/setup').send(OWNER)).status).toBe(201);
  expect((await owner.post('/api/users').send({ ...BOB, roles: ['admin'] })).status).toBe(201);

  const created = await owner
    .post('/api/shares')
    .send({ sourcePath: 'Projects/Report', sharingType: 'anyone', password: SHARE_PASSWORD });
  expect(created.status).toBe(201);
  token = created.body.shareToken;

  bob = request.agent(app);
  expect(
    (await bob.post('/api/auth/login').send({ email: BOB.email, password: BOB.password })).status
  ).toBe(200);
}, 60000);

afterAll(async () => {
  await envContext?.cleanup();
});

describe('an account that did not create the link', () => {
  it('is told it needs the password', async () => {
    const info = await bob.get(`/api/share/${token}/info`);

    expect(info.status).toBe(200);
    expect(info.body.requiresPassword).toBe(true);
  });

  it('is refused the share, its contents and its files until it gives it', async () => {
    const access = await bob.get(`/api/share/${token}/access`);
    expect(access.status).toBe(401);
    expect(access.body.error?.message || access.body.error).toMatch(
      /Password verification required/
    );

    const listing = await bob.get(`/api/browse/share/${token}`);
    expect(listing.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(listing.body)).not.toContain('plan.txt');

    const direct = await bob.get(`/api/share/${token}/file/plan.txt`);
    expect(direct.status).not.toBe(200);
    expect(direct.text).not.toBe('plan');
  });

  it('is let in once it has given it, and stays in', async () => {
    const wrong = await bob.post(`/api/share/${token}/verify`).send({ password: 'not-it' });
    expect(wrong.status).toBe(401);

    const verified = await bob
      .post(`/api/share/${token}/verify`)
      .send({ password: SHARE_PASSWORD });
    expect(verified.status).toBe(200);

    expect((await bob.get(`/api/share/${token}/access`)).status).toBe(200);
    const listing = await bob.get(`/api/browse/share/${token}`);
    expect(listing.status).toBe(200);
    expect(JSON.stringify(listing.body)).toContain('plan.txt');
  });

  // The guest session it now carries is not a demotion: the account may still
  // do what it could do before it opened the link.
  it('may still change permissions elsewhere, the guest session beside it', async () => {
    const chmod = await bob
      .post('/api/permissions/chmod')
      .send({ path: 'Bob/notes.txt', mode: '640' });

    expect(chmod.status).toBe(200);
    const stats = await fs.stat(path.join(envContext.volumeDir, 'Bob', 'notes.txt'));
    expect(stats.mode & 0o777).toBe(0o640);
  });
});

describe('the account that created the link', () => {
  it('is not asked for it', async () => {
    const info = await owner.get(`/api/share/${token}/info`);
    expect(info.body.requiresPassword).toBe(false);

    expect((await owner.get(`/api/share/${token}/access`)).status).toBe(200);
    const listing = await owner.get(`/api/browse/share/${token}`);
    expect(listing.status).toBe(200);
    expect(JSON.stringify(listing.body)).toContain('plan.txt');
  });
});
