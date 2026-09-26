import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What a caller who needs no account can do to the server, bounded.
 *
 * - A share password is checked with bcrypt on a public URL. With no limit
 *   it was a brute-force surface, and a way to keep the server busy.
 * - The guest session a share password buys was never marked Secure, unlike
 *   the login cookie, so it could be replayed in clear text.
 * - A failed sign-in for an address that has no account counted towards a
 *   lock keyed on the address alone: an address could be locked before its
 *   account existed.
 * - An upload had no ceiling at all, so one request could stream until the
 *   volume was full; and meeting a limit answered as if the server had failed.
 */

let envContext;

afterEach(async () => {
  await envContext?.cleanup();
  envContext = null;
});

const OWNER = { id: 'owner', email: 'owner@example.com', roles: ['admin'] };

const shareApp = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'public-endpoints-', env });
  const db = await envContext.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('owner', 'owner@example.com', 1, 'owner', 'Owner', '["admin"]', ?, ?)`
  ).run(now, now);
  await fs.mkdir(path.join(envContext.volumeDir, 'Shared'), { recursive: true });

  const shares = envContext.requireFresh('src/routes/shares');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-owner']) req.user = OWNER;
    next();
  });
  app.use('/api/shares', shares);
  app.use('/api/share', shares);
  app.use(errorHandler);

  const created = await request(app)
    .post('/api/shares')
    .set('x-test-owner', '1')
    .send({ sourcePath: 'Shared', sharingType: 'anyone', password: 'open-sesame' });
  expect(created.status).toBe(201);
  return { app, token: created.body.shareToken };
};

describe('checking a share password', () => {
  it('stops answering after twenty attempts from one client', async () => {
    const { app, token } = await shareApp();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request(app)
        .post(`/api/share/${token}/verify`)
        .send({ password: `guess-${attempt}` });
      expect(response.status).toBe(401);
    }
    const blocked = await request(app)
      .post(`/api/share/${token}/verify`)
      .send({ password: 'open-sesame' });

    expect(blocked.status).toBe(429);
  }, 30000);

  it('hands out a guest cookie marked Secure when the request came over HTTPS', async () => {
    const { app, token } = await shareApp();

    const overHttps = await request(app)
      .post(`/api/share/${token}/verify`)
      .set('X-Forwarded-Proto', 'https')
      .send({ password: 'open-sesame' });
    const overHttp = await request(app)
      .post(`/api/share/${token}/verify`)
      .send({ password: 'open-sesame' });

    const cookieOf = (response) =>
      [].concat(response.headers['set-cookie'] || []).find((c) => c.startsWith('guestSession='));
    expect(overHttps.status).toBe(200);
    expect(cookieOf(overHttps)).toMatch(/;\s*Secure/i);
    // The control: plain HTTP cannot carry a Secure cookie back at all.
    expect(cookieOf(overHttp)).not.toMatch(/;\s*Secure/i);
  });
});

describe('a failed sign-in for an address with no account', () => {
  it('counts nothing against an account created at that address later', async () => {
    envContext = await setupTestEnv({ tag: 'lock-unknown-' });
    const users = envContext.requireFresh('src/services/users');

    for (let attempt = 0; attempt < 12; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(
        await users.attemptLocalLogin({ email: 'newcomer@example.com', password: 'guess' })
      ).toBeNull();
    }
    await users.createLocalUser({
      email: 'newcomer@example.com',
      password: 'the-real-one',
      username: 'newcomer',
    });

    const signedIn = await users.attemptLocalLogin({
      email: 'newcomer@example.com',
      password: 'the-real-one',
    });
    expect(signedIn?.email).toBe('newcomer@example.com');
  }, 30000);
});

describe('an upload', () => {
  const uploadApp = async (env) => {
    envContext = await setupTestEnv({ tag: 'upload-limits-', env });
    await fs.mkdir(path.join(envContext.volumeDir, 'Drop'), { recursive: true });
    const upload = envContext.requireFresh('src/routes/upload');
    const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
    const app = express();
    app.use((req, _res, next) => {
      req.user = OWNER;
      next();
    });
    app.use('/api', upload);
    app.use(errorHandler);
    return app;
  };

  it('is refused, as a refusal, when a file is over the size ceiling', async () => {
    const app = await uploadApp({ MAX_DIRECT_UPLOAD_SIZE: '1K' });

    const response = await request(app)
      .post('/api/upload')
      .field('uploadTo', 'Drop')
      .attach('filedata', Buffer.alloc(4096, 1), 'big.bin');

    expect(response.status).toBe(413);
    // The upload route's own sentence, which names the ceiling and the variable
    // that raises it. It sets that sentence through `explainMultipartRefusals` and
    // the error handler was discarding it, so this used to read the generic
    // "larger than this server accepts" — green, for the wrong reason.
    expect(response.body.error.message).toMatch(/larger than the .* a direct upload accepts/);
    expect(response.body.error.message).toMatch(/MAX_DIRECT_UPLOAD_SIZE/);
    expect(await fs.readdir(path.join(envContext.volumeDir, 'Drop'))).toEqual([]);
  });

  it('is refused when it carries more files than one request may', async () => {
    const app = await uploadApp({ MAX_FILES_PER_UPLOAD: '2' });

    const response = await request(app)
      .post('/api/upload')
      .field('uploadTo', 'Drop')
      .attach('filedata', Buffer.from('a'), 'a.txt')
      .attach('filedata', Buffer.from('b'), 'b.txt')
      .attach('filedata', Buffer.from('c'), 'c.txt');

    expect([400, 413]).toContain(response.status);
  });

  it('is taken when it is within them', async () => {
    const app = await uploadApp({ MAX_DIRECT_UPLOAD_SIZE: '1K', MAX_FILES_PER_UPLOAD: '2' });

    const response = await request(app)
      .post('/api/upload')
      .field('uploadTo', 'Drop')
      .attach('filedata', Buffer.from('small'), 'small.txt');

    expect(response.status).toBe(200);
    expect(await fs.readdir(path.join(envContext.volumeDir, 'Drop'))).toEqual(['small.txt']);
  });
});
