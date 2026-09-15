import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Where a direct upload ends up, and what it leaves when it does not finish.
 *
 * The destination a person picks is authorized once. Every file then carries a
 * relative path the browser made up from the folder that was dropped, and that
 * path decides where the bytes really go: into a subfolder an administrator
 * hid or made read-only, into the zone that holds what people deleted, beside
 * a file that already has the name, or up and out of the destination
 * altogether. And an upload that dies half way — too large, cancelled, or a
 * client that stopped sending — must not leave a truncated file presented as
 * the real one, nor a `.uploading` remnant filling the disk.
 *
 * `direct-upload` covers the upload that works, the full volume and the sweep
 * of old remnants; `upload-authorization` covers the chosen destination.
 */

const fsp = require('fs/promises');

const ADMIN = { id: 'admin-1', roles: ['admin'] };
const REGULAR = { id: 'user-1', roles: ['user'] };
const BOUNDARY = 'upload-landing-boundary';

let envContext;
let server;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const seed = async ({ env = {}, rules = [] } = {}) => {
  envContext = await setupTestEnv({ tag: 'upload-landing-', env });
  if (rules.length) {
    await envContext.requireFresh('src/services/accessControlService').setRules(rules);
  }
  const destination = path.join(envContext.volumeDir, 'Nvm');
  await fs.mkdir(destination, { recursive: true });
  return destination;
};

const buildApp = (user = ADMIN) => {
  const routes = envContext.requireFresh('src/routes/upload');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

const upload = (app, query, { name = 'file.txt', content = 'content' } = {}) =>
  request(app).post('/api/upload').query(query).attach('filedata', Buffer.from(content), name);

const reason = (response) => response.body?.error?.message || response.text;

const exists = (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

/** Every entry under `dir`, relative to it. */
const tree = async (dir) => {
  const entries = await fs.readdir(dir, { recursive: true });
  return entries.map((entry) => entry.split(path.sep).join('/')).sort();
};

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

const partHead = (name) =>
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="filedata"; filename="${name}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'
  );

const listen = async (app) => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return server.address().port;
};

/**
 * Start an upload that announces a large file and sends only its beginning,
 * leaving the connection open: what a browser tab looks like mid-transfer.
 */
const startPartialUpload = (port, name) => {
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: `/api/upload?uploadTo=Nvm&relativePath=${encodeURIComponent(name)}`,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
      'Content-Length': String(64 * 1024 * 1024),
    },
  });
  // The connection is cut on purpose; the error that follows is expected.
  req.on('error', () => {});
  req.write(partHead(name));
  req.write(Buffer.alloc(256 * 1024, 7));
  return req;
};

describe('a name already taken', () => {
  it('keeps the file that was there and gives the upload a numbered name', async () => {
    const destination = await seed();
    await fs.writeFile(path.join(destination, 'report.txt'), 'the original');

    const response = await upload(
      buildApp(),
      { uploadTo: 'Nvm', relativePath: 'report.txt' },
      { name: 'report.txt', content: 'the upload' }
    );

    expect(response.status).toBe(200);
    expect(await fs.readFile(path.join(destination, 'report.txt'), 'utf8')).toBe('the original');
    expect(await fs.readFile(path.join(destination, 'report (1).txt'), 'utf8')).toBe('the upload');
  });
});

describe('the folder a relative path lands in', () => {
  it('is refused when an administrator hid it, though the chosen destination is open', async () => {
    const destination = await seed({
      rules: [{ path: 'Nvm/Secret', recursive: true, permissions: 'hidden' }],
    });
    await fs.mkdir(path.join(destination, 'Secret'));
    const app = buildApp(ADMIN);

    // Both ways a client names it: the path from the folder picker, and the
    // one a folder session already resolved.
    for (const query of [
      { uploadTo: 'Nvm', relativePath: 'Secret/planted.txt' },
      { uploadTo: 'Nvm', resolvedRelativePath: 'Secret/planted.txt' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await upload(app, query, { name: 'planted.txt' });

      expect(response.status).toBe(403);
      expect(reason(response)).toBe('Path is hidden');
    }
    expect(await tree(path.join(destination, 'Secret'))).toEqual([]);
  });

  /**
   * Read-only answers with the generic refusal, the same words the chosen
   * destination would use. The upload into `Nvm` itself succeeding is what
   * shows it was the subfolder that said no.
   */
  it('is refused when it is read-only for someone who may write the destination', async () => {
    const destination = await seed({
      rules: [{ path: 'Nvm/Archive', recursive: true, permissions: 'ro' }],
    });
    await fs.mkdir(path.join(destination, 'Archive'));
    const app = buildApp(REGULAR);

    const beside = await upload(app, { uploadTo: 'Nvm', relativePath: 'beside.txt' });
    const inside = await upload(app, { uploadTo: 'Nvm', relativePath: 'Archive/inside.txt' });

    expect(beside.status).toBe(200);
    expect(inside.status).toBe(403);
    expect(reason(inside)).toBe('Cannot upload files to this path.');
    expect(await tree(path.join(destination, 'Archive'))).toEqual([]);
  });

  /**
   * The zone sits inside every volume, so any folder upload into a volume's
   * root is one crafted relative path away from it. A file planted there could
   * pose as a deleted item, or as an earlier version of someone's document.
   */
  it('is refused when it is the zone that holds deleted files', async () => {
    const destination = await seed();
    await fs.writeFile(path.join(destination, 'deleted.txt'), 'deleted');
    await envContext
      .requireFresh('src/services/trash/operations')
      .moveToTrash({ absolutePath: path.join(destination, 'deleted.txt') });
    const zone = path.join(destination, '.nextexplorer');
    const before = await tree(zone);
    expect(before).toContain('trash');
    const app = buildApp(ADMIN);

    for (const query of [
      { uploadTo: 'Nvm', relativePath: '.nextexplorer/trash/planted.txt' },
      { uploadTo: 'Nvm', resolvedRelativePath: '.nextexplorer/versions/planted.txt' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await upload(app, query, { name: 'planted.txt' });

      expect(response.status).toBe(403);
      expect(reason(response)).toMatch(/reserved by the application/);
    }
    expect(await tree(zone)).toEqual(before);
  });
});

describe('a relative path that points elsewhere', () => {
  it('cannot climb out of the chosen destination into a sibling folder', async () => {
    const destination = await seed();
    await fs.mkdir(path.join(destination, 'Inbox'));
    await fs.mkdir(path.join(destination, 'Other'));

    const app = buildApp(ADMIN);

    // The resolved form matters most: it skips the folder reservation, which
    // would otherwise normalize the path a second time on the way through.
    for (const query of [
      { uploadTo: 'Nvm/Inbox', relativePath: '../Other/moved.txt' },
      { uploadTo: 'Nvm/Inbox', resolvedRelativePath: '../Other/moved.txt' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await upload(app, query);

      expect(response.status).toBe(400);
      expect(reason(response)).toMatch(/traversal/i);
    }
    expect(await tree(path.join(destination, 'Other'))).toEqual([]);
  });

  it('cannot climb out of the volume, whichever separator it is written with', async () => {
    await seed();
    // What the application keeps in its own directories comes and goes as
    // modules load; the question is only whether a file appeared anywhere else.
    const foreign = async () =>
      (await tree(envContext.tmpRoot)).filter((entry) => !/^(config|cache)(\/|$)/.test(entry));
    const outside = await foreign();
    const app = buildApp(ADMIN);

    for (const climb of ['../../escaped.txt', '..\\..\\..\\escaped.txt']) {
      for (const key of ['relativePath', 'resolvedRelativePath']) {
        // eslint-disable-next-line no-await-in-loop
        const response = await upload(app, { uploadTo: 'Nvm', [key]: climb });

        expect(response.status).toBe(400);
        expect(reason(response)).toMatch(/traversal/i);
      }
    }
    expect(await foreign()).toEqual(outside);
  });

  it('takes an absolute path as one under the destination', async () => {
    const destination = await seed();

    const response = await upload(buildApp(ADMIN), {
      uploadTo: 'Nvm',
      relativePath: '/etc/hosts-copy.txt',
    });

    expect(response.status).toBe(200);
    expect(await exists(path.join(destination, 'etc', 'hosts-copy.txt'))).toBe(true);
  });
});

describe('an upload that does not finish', () => {
  /**
   * The parser stops a file at the size limit by ending it early, so to the
   * storage the truncated file looks complete and is moved into place. It is
   * the removal afterwards that keeps a cut-off copy from sitting there under
   * the real name.
   */
  it('leaves nothing behind when it is larger than the limit', async () => {
    const destination = await seed({ env: { MAX_DIRECT_UPLOAD_SIZE: '1K' } });

    const response = await upload(
      buildApp(ADMIN),
      { uploadTo: 'Nvm', relativePath: 'large.bin' },
      { name: 'large.bin', content: 'x'.repeat(64 * 1024) }
    );

    expect(response.status).not.toBe(200);
    expect(reason(response)).toMatch(/file too large/i);
    expect(await tree(destination)).toEqual([]);
  });

  it('leaves nothing behind when the client goes away half way', async () => {
    const destination = await seed();
    const port = await listen(buildApp(ADMIN));
    const temporary = path.join(destination, 'film.mkv.uploading');

    const req = startPartialUpload(port, 'film.mkv');
    expect(await waitFor(() => exists(temporary))).toBe(true);

    req.destroy();

    expect(await waitFor(async () => (await tree(destination)).length === 0)).toBe(true);
  });

  /**
   * A client that stops sending without closing — a laptop lid, a network that
   * drops silently — would otherwise hold its half-written file for as long
   * as the connection lingers. The connection stays open for the whole of this
   * test, so the cleanup cannot be the disconnect's doing.
   */
  it('leaves nothing behind when the client stops sending and never hangs up', async () => {
    const destination = await seed({ env: { UPLOAD_INACTIVITY_TIMEOUT: '300' } });
    const port = await listen(buildApp(ADMIN));
    const temporary = path.join(destination, 'stalled.bin.uploading');

    const req = startPartialUpload(port, 'stalled.bin');
    try {
      expect(await waitFor(() => exists(temporary))).toBe(true);

      expect(await waitFor(async () => (await tree(destination)).length === 0)).toBe(true);
      expect(req.destroyed).toBe(false);
    } finally {
      req.destroy();
    }
  });
});

describe('the room left for a request of several files', () => {
  /**
   * Room is measured once, against the whole request, before its first file.
   * Measured again for the second file, the whole request would be weighed
   * against the space left after the first had landed, and an upload that fits
   * would be refused half way through.
   */
  it('is not measured again for each file, which would refuse what fits', async () => {
    const destination = await seed({ env: { UPLOAD_STORAGE_RESERVE: '0' } });
    // The parser only knows a file has ended once it sees the next boundary, so
    // the first chunk carries that boundary and the second chunk the rest.
    const secondHead = partHead('second.bin');
    const nextBoundary = Buffer.from(`--${BOUNDARY}\r\n`);
    const firstChunk = Buffer.concat([
      partHead('first.bin'),
      Buffer.alloc(4000, 1),
      Buffer.from('\r\n'),
      nextBoundary,
    ]);
    const rest = Buffer.concat([
      secondHead.subarray(nextBoundary.length),
      Buffer.alloc(4000, 2),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    const declared = firstChunk.length + rest.length;

    // A volume with just over the request's size free, which shrinks as files land.
    const capacity = declared + 1000;
    vi.spyOn(fsp, 'statfs').mockImplementation(async () => {
      const names = await fs.readdir(destination);
      const sizes = await Promise.all(
        names.map((name) => fs.stat(path.join(destination, name)).then((stats) => stats.size))
      );
      const used = sizes.reduce((total, size) => total + size, 0);
      return { bavail: Math.max(0, capacity - used), bsize: 1, blocks: 1_000_000 };
    });

    const port = await listen(buildApp(ADMIN));
    const response = new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/upload?uploadTo=Nvm',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
            'Content-Length': String(declared),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.write(firstChunk);
      // The second file is sent only once the first has landed, so the space
      // it takes is already gone when the second one starts.
      waitFor(() => exists(path.join(destination, 'first.bin'))).then((landed) => {
        if (!landed) req.destroy(new Error('the first file never landed'));
        else req.end(rest);
      });
    });

    expect(await response).toBe(200);
    expect(await tree(destination)).toEqual(['first.bin', 'second.bin']);
  });
});
