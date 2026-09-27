import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Getting bytes back out.
 *
 * The route had 19.8% coverage while deciding two things that matter: whether
 * the caller is allowed the file at all, and what the browser will call what it
 * receives. The second sounds cosmetic and is not — the name is built from a
 * logical path, a base path and a share prefix, and getting it wrong hands
 * somebody a file called `share` or a zip named after the wrong folder.
 *
 * Downloading is also its own permission. A share can be readable and still
 * refuse downloads, which is the difference between "look at this" and "take a
 * copy", and nothing else in the suite covered that branch.
 */

const setup = async ({ user = { id: 'admin', roles: ['admin'] }, env = {} } = {}) => {
  const envContext = await setupTestEnv({
    tag: 'download-test-',
    env,
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/files/download',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/services/settingsService',
    ],
  });

  const volume = envContext.volumeDir;
  await fs.mkdir(path.join(volume, 'Docs/2026'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Docs/report.txt'), 'annual report');
  await fs.writeFile(path.join(volume, 'Docs/notes.md'), '# notes');
  await fs.writeFile(path.join(volume, 'Docs/.env'), 'SECRET=1');
  await fs.writeFile(path.join(volume, 'Docs/2026/q1.txt'), 'first quarter');

  const routes = envContext.requireFresh('src/routes/files/download');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const { getDb } = envContext.requireFresh('src/services/db');
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', now, now);

  const app = createTestApp({ router: routes, mountPath: '/api', user, errorHandler });
  return { envContext, app };
};

let ctx;
afterEach(async () => {
  if (ctx) {
    await ctx.envContext.cleanup();
    ctx = null;
  }
});

const post = async (body, options) => {
  ctx = await setup(options);
  return request(ctx.app).post('/api/download').send(body);
};

/** supertest leaves an unknown content type as a string; a zip needs its bytes. */
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const postBinary = async (body, options) => {
  ctx = await setup(options);
  return request(ctx.app).post('/api/download').send(body).buffer().parse(binary);
};

describe('what it refuses before reading anything', () => {
  it('asks for a path when the body carries none', async () => {
    const response = await post({});

    expect(response.status).toBe(400);
  });

  it('asks again when every path normalises away to nothing', async () => {
    const response = await post({ paths: ['', '   ', null] });

    expect(response.status).toBe(400);
  });

  it('refuses a path that climbs out of the volume', async () => {
    const response = await post({ paths: ['Docs/../../etc/passwd'] });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('one file', () => {
  it('sends it under its own name', async () => {
    const response = await post({ paths: ['Docs/report.txt'] });

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('report.txt');
    expect(response.text).toBe('annual report');
  });

  /**
   * Express refuses dotfiles by default, which would make `.env`, `.gitignore`
   * and every dotfile in a repository undownloadable with no message saying so.
   */
  it('sends a dotfile, which Express would otherwise refuse', async () => {
    const response = await postBinary({ paths: ['Docs/.env'] });

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('SECRET=1');
  });

  it('names it from the base path when one is given', async () => {
    const response = await post({ paths: ['Docs/2026/q1.txt'], basePath: 'Docs' });

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('q1.txt');
  });

  it('accepts the singular `path` field as well as `paths`', async () => {
    const response = await post({ path: 'Docs/report.txt' });

    expect(response.status).toBe(200);
    expect(response.text).toBe('annual report');
  });
});

describe('when it has to build a zip', () => {
  const isZip = (response) => {
    expect(response.headers['content-type']).toContain('zip');
    // Local file header — proves an archive came back rather than a file.
    expect(response.body.subarray(0, 2).toString('latin1')).toBe('PK');
  };

  it('archives two files rather than sending one', async () => {
    const response = await postBinary({
      paths: ['Docs/report.txt', 'Docs/notes.md'],
      basePath: 'Docs',
    });

    expect(response.status).toBe(200);
    isZip(response);
  });

  it('archives a single directory', async () => {
    const response = await postBinary({ paths: ['Docs/2026'], basePath: 'Docs' });

    expect(response.status).toBe(200);
    isZip(response);
    expect(response.headers['content-disposition']).toContain('2026.zip');
  });

  it('names a multi-item archive after the folder they came from', async () => {
    const response = await post({ paths: ['Docs/report.txt', 'Docs/notes.md'], basePath: 'Docs' });

    expect(response.headers['content-disposition']).toContain('Docs.zip');
  });

  it('falls back to download.zip when there is no base path to name it after', async () => {
    const response = await post({ paths: ['Docs/report.txt', 'Docs/notes.md'] });

    expect(response.headers['content-disposition']).toContain('download.zip');
  });

  /**
   * The same file twice is one file. Without the dedupe the archive carries two
   * entries of the same name, which some extractors silently collapse and
   * others refuse.
   */
  it('treats the same path listed twice as one', async () => {
    const response = await post({ paths: ['Docs/report.txt', 'Docs/report.txt'] });

    expect(response.status).toBe(200);
    // One target left after the dedupe, so this is a plain file, not a zip.
    expect(response.headers['content-type']).not.toContain('zip');
    expect(response.text).toBe('annual report');
  });
});

describe('a caller who may not reach the file', () => {
  /**
   * `USER_VOLUMES=true` with an account assigned no volume: the access check is
   * the only thing that can refuse here.
   *
   * Note what this does NOT cover. The route also tests `accessInfo.canDownload`,
   * and no test can reach that branch, because `canDownload` is set to `true`
   * everywhere it is set except in the denied-access object — where `canAccess`
   * is already false and answers first. Removing the check from the route breaks
   * nothing, which is how it was found. It is recorded in TODO.md rather than
   * asserted here: a test that claims to cover it would be claiming something
   * untrue.
   */
  it('is refused, and told it is a permission problem', async () => {
    const response = await post(
      { paths: ['Docs/report.txt'] },
      { user: { id: 'nobody', roles: ['user'] }, env: { USER_VOLUMES: 'true' } }
    );

    expect(response.status).toBe(403);
  });

  it('is refused even when one path in the list is allowed', async () => {
    const response = await post(
      { paths: ['Docs/report.txt', 'Docs/notes.md'] },
      { user: { id: 'nobody', roles: ['user'] }, env: { USER_VOLUMES: 'true' } }
    );

    expect(response.status).toBe(403);
  });
});
