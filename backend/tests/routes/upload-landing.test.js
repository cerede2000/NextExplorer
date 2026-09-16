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

/** The hidden files uploads are written through, in `dir`. */
const temporaries = async (dir) =>
  (await fs.readdir(dir)).filter((name) => /^\.upload-[0-9a-f]{16}\.uploading$/.test(name));

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
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
    // What the listing and the person are told is the name it really took.
    expect(response.body).toEqual([
      expect.objectContaining({ name: 'report (1).txt', path: 'Nvm' }),
    ]);
  });

  /**
   * The name used to be chosen before the transfer and taken by a rename after
   * it, which replaces a file silently: whatever arrived under it in between —
   * another upload, a copy, a file saved over SMB — was lost. A file is put
   * under the name at the last moment, after every byte arrived and just
   * before the upload takes the name.
   */
  it('keeps a file that arrives under the name at the last moment', async () => {
    const destination = await seed();
    const target = path.join(destination, 'report.txt');

    let arrived = false;
    const arriveFirst = (original) =>
      async function arriving(from, to) {
        if (!arrived && String(from).endsWith('.uploading') && to === target) {
          arrived = true;
          await fs.writeFile(target, 'arrived meanwhile');
        }
        return original.call(this, from, to);
      };
    const { link, rename } = fsp;
    vi.spyOn(fsp, 'link').mockImplementation(arriveFirst(link));
    vi.spyOn(fsp, 'rename').mockImplementation(arriveFirst(rename));

    const response = await upload(
      buildApp(),
      { uploadTo: 'Nvm', relativePath: 'report.txt' },
      { name: 'report.txt', content: 'the upload' }
    );

    expect(arrived).toBe(true);
    expect(response.status).toBe(200);
    expect(await fs.readFile(target, 'utf8')).toBe('arrived meanwhile');
    expect(await fs.readFile(path.join(destination, 'report (1).txt'), 'utf8')).toBe('the upload');
    // Named and measured after the file it became, not the one that arrived.
    expect(response.body).toEqual([
      expect.objectContaining({ name: 'report (1).txt', size: 'the upload'.length }),
    ]);
    expect(await tree(destination)).toEqual(['report (1).txt', 'report.txt']);
  });

  /**
   * Two uploads of one name at once used to pick the same name, and so the
   * same `name.uploading` temporary: each wrote into the other's file, and the
   * rename of the first left the second nothing to rename. Both are sent half
   * way before either finishes.
   */
  it('gives two uploads of the same name at once a name each, with their own content', async () => {
    const destination = await seed();
    const port = await listen(buildApp(ADMIN));

    const send = (content) => {
      const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
      const head = partHead('notes.txt');
      const body = Buffer.from(content);
      const half = Math.floor(body.length / 2);
      let resolveResponse;
      const response = new Promise((resolve, reject) => {
        resolveResponse = { resolve, reject };
      });
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/upload?uploadTo=Nvm&relativePath=notes.txt',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
            'Content-Length': String(head.length + body.length + tail.length),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolveResponse.resolve({ status: res.statusCode, text }));
        }
      );
      req.on('error', (err) => resolveResponse.reject(err));
      req.write(Buffer.concat([head, body.subarray(0, half)]));
      return { finish: () => req.end(Buffer.concat([body.subarray(half), tail])), response };
    };

    const first = send('a'.repeat(128 * 1024));
    const second = send('b'.repeat(128 * 1024));
    // Both are writing before either finishes. The old code shared one
    // temporary between them, so this only waits as long as it has to.
    await waitFor(async () => (await temporaries(destination)).length === 2, 1500);
    first.finish();
    second.finish();
    const answers = await Promise.all([first.response, second.response]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const told = answers.map((answer) => JSON.parse(answer.text)[0].name).sort();
    expect(told).toEqual(['notes (1).txt', 'notes.txt']);
    expect(await tree(destination)).toEqual(['notes (1).txt', 'notes.txt']);
    const contents = await Promise.all(
      told.map((name) => fs.readFile(path.join(destination, name), 'utf8'))
    );
    expect(contents.sort()).toEqual(['a'.repeat(128 * 1024), 'b'.repeat(128 * 1024)]);
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
      const response = await upload(app, query, { name: 'planted.txt' });

      expect(response.status).toBe(403);
      expect(reason(response)).toMatch(/reserved by the application/);
    }
    expect(await tree(zone)).toEqual(before);
  });
});

/**
 * The folder a picked folder is poured into is created by the server, before
 * any file of the batch arrives: a folder session reserves it, and so does the
 * first file of a batch that has no session. That reservation used to come
 * before the folder was authorized, so a refusal left it behind, empty — and
 * `.nextexplorer`, the zone's own name, left one that no path can reach again.
 */
describe('what a refused folder upload leaves', () => {
  const startSession = (app, body) => request(app).post('/api/upload/folder-session').send(body);

  it('does not take the zone name for a folder session', async () => {
    const destination = await seed();

    const response = await startSession(buildApp(ADMIN), {
      uploadTo: 'Nvm',
      sourceRoot: '.nextexplorer',
    });

    expect(response.status).toBe(403);
    expect(reason(response)).toMatch(/reserved by the application/);
    expect(await tree(destination)).toEqual([]);
  });

  it('does not create the folder a session asks for where an administrator hid it', async () => {
    const destination = await seed({
      rules: [{ path: 'Nvm/Secret', recursive: true, permissions: 'hidden' }],
    });

    const response = await startSession(buildApp(ADMIN), { uploadTo: 'Nvm', sourceRoot: 'Secret' });

    expect(response.status).toBe(403);
    expect(reason(response)).toBe('Path is hidden');
    expect(await tree(destination)).toEqual([]);
  });

  it('does not create the folder a session asks for where it is read-only', async () => {
    const destination = await seed({
      rules: [{ path: 'Nvm/Archive', recursive: true, permissions: 'ro' }],
    });

    const response = await startSession(buildApp(REGULAR), {
      uploadTo: 'Nvm',
      sourceRoot: 'Archive',
    });

    expect(response.status).toBe(403);
    expect(reason(response)).toBe('Cannot upload files to this path.');
    expect(await tree(destination)).toEqual([]);
  });

  /**
   * A batch without a session reserves its folder on the first file. The batch
   * id is what turns that reservation on, so it is the form that leaves
   * something behind — the same request without one is refused with nothing
   * created, and is covered above.
   */
  it.each([
    ['the zone name', '.nextexplorer/trash/planted.txt', [], /reserved by the application/],
    ['a folder an administrator hid', 'Secret/planted.txt', ['Nvm/Secret'], /hidden/],
  ])('does not create %s for a batch of files', async (_label, relativePath, paths, refusal) => {
    const destination = await seed({
      rules: paths.map((rulePath) => ({
        path: rulePath,
        recursive: true,
        permissions: 'hidden',
      })),
    });

    const response = await upload(
      buildApp(ADMIN),
      { uploadTo: 'Nvm', relativePath, uploadBatchId: 'batch-refused-0001' },
      { name: 'planted.txt' }
    );

    expect(response.status).toBe(403);
    expect(reason(response)).toMatch(refusal);
    expect(await tree(destination)).toEqual([]);
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
   * storage the truncated file looks complete: it was moved into place and
   * removed a moment later, and nothing is left either way. What is watched
   * here is that moment in between — the name a refused upload must never
   * hold, since it is the name another upload may be asking for right then.
   *
   * A name is taken by the link or the rename that puts a file under it, so
   * every one of those is recorded and the refused name must not be among
   * them. `fs.open(target, 'wx')` on a filesystem without hard links is
   * followed by the rename that is recorded here.
   */
  it('never takes the name it asked for when it is larger than the limit', async () => {
    const destination = await seed({ env: { MAX_DIRECT_UPLOAD_SIZE: '1K' } });
    const taken = [];
    const record = (original, target) =>
      function taking(...args) {
        taken.push(String(args[target]));
        return original.apply(this, args);
      };
    const { link, rename } = fsp;
    vi.spyOn(fsp, 'link').mockImplementation(record(link, 1));
    vi.spyOn(fsp, 'rename').mockImplementation(record(rename, 1));

    const response = await upload(
      buildApp(ADMIN),
      { uploadTo: 'Nvm', relativePath: 'large.bin' },
      { name: 'large.bin', content: 'x'.repeat(64 * 1024) }
    );

    // 413 naming the limit and the setting, not multer's "File too large" as a 500.
    expect(response.status).toBe(413);
    expect(reason(response)).toMatch(/larger than the 1 KB a direct upload accepts/);
    expect(taken).not.toContain(path.join(destination, 'large.bin'));
    expect(await tree(destination)).toEqual([]);
  });

  it('leaves nothing behind when the client goes away half way', async () => {
    const destination = await seed();
    const port = await listen(buildApp(ADMIN));

    const req = startPartialUpload(port, 'film.mkv');
    expect(await waitFor(async () => (await temporaries(destination)).length === 1)).toBe(true);

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

    const req = startPartialUpload(port, 'stalled.bin');
    try {
      expect(await waitFor(async () => (await temporaries(destination)).length === 1)).toBe(true);

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
