import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * An upload writes into a folder somebody already keeps things in. It must
 * never replace what is there: a file already under the name, a file that
 * arrives under it while the bytes are still coming, or another upload of the
 * same name running at the same time. And it tells the person the name it
 * really took.
 */

const fsp = require('fs/promises');

const ADMIN = { id: 'admin-1', roles: ['admin'] };
const BOUNDARY = 'upload-never-overwrite-boundary';

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

const seed = async () => {
  envContext = await setupTestEnv({ tag: 'upload-never-overwrite-' });
  const destination = path.join(envContext.volumeDir, 'Nvm');
  await fs.mkdir(destination, { recursive: true });
  return destination;
};

const buildApp = () => {
  const routes = envContext.requireFresh('src/routes/upload');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = ADMIN;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

// The destination travels as form fields ahead of the file, as the browser sends it.
const upload = (app, { name = 'file.txt', content = 'content' } = {}) =>
  request(app)
    .post('/api/upload')
    .field('uploadTo', 'Nvm')
    .field('relativePath', name)
    .attach('filedata', Buffer.from(content), name);

/** Every entry under `dir`, hidden ones included. */
const listing = async (dir) => (await fs.readdir(dir)).sort();

/** The hidden files uploads are written through, in `dir`. */
const temporaries = async (dir) =>
  (await fs.readdir(dir)).filter((name) => /^\.upload-[0-9a-f]{16}\.uploading$/.test(name));

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

const field = (name, value) =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;

const partHead = (name) =>
  Buffer.from(
    field('uploadTo', 'Nvm') +
      field('relativePath', name) +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="filedata"; filename="${name}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'
  );

// On the loopback address the requests are sent to, never a bare port.
const listen = async (app) => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};

/** An upload sent half way, finished when asked: two can be in flight at once. */
const sendInTwoHalves = (port, name, content) => {
  const head = partHead(name);
  const body = Buffer.from(content);
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const half = Math.floor(body.length / 2);
  let settle;
  const response = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/upload',
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
      res.on('end', () => settle.resolve({ status: res.statusCode, text }));
    }
  );
  req.on('error', (err) => settle.reject(err));
  req.write(Buffer.concat([head, body.subarray(0, half)]));
  return {
    finish: () => req.end(Buffer.concat([body.subarray(half), tail])),
    cut: () => req.destroy(),
    response,
  };
};

describe('an upload under a name already taken', () => {
  it('keeps the file that was there and says which name the upload took', async () => {
    const destination = await seed();
    await fs.writeFile(path.join(destination, 'report.txt'), 'the original');

    const response = await upload(buildApp(), { name: 'report.txt', content: 'the upload' });

    expect(response.status).toBe(200);
    expect(await fs.readFile(path.join(destination, 'report.txt'), 'utf8')).toBe('the original');
    expect(await fs.readFile(path.join(destination, 'report (1).txt'), 'utf8')).toBe('the upload');
    // What the listing and the person are told is the name it really took.
    expect(response.body).toEqual([
      expect.objectContaining({ name: 'report (1).txt', path: 'Nvm' }),
    ]);
    expect(await listing(destination)).toEqual(['report (1).txt', 'report.txt']);
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

    const response = await upload(buildApp(), { name: 'report.txt', content: 'the upload' });

    expect(arrived).toBe(true);
    expect(response.status).toBe(200);
    expect(await fs.readFile(target, 'utf8')).toBe('arrived meanwhile');
    expect(await fs.readFile(path.join(destination, 'report (1).txt'), 'utf8')).toBe('the upload');
    // Named and measured after the file it became, not the one that arrived.
    expect(response.body).toEqual([
      expect.objectContaining({ name: 'report (1).txt', size: 'the upload'.length }),
    ]);
    expect(await listing(destination)).toEqual(['report (1).txt', 'report.txt']);
  });

  /**
   * Two uploads of one name at once used to pick the same name, and so the
   * same `name.uploading` temporary: each wrote into the other's file, and the
   * rename of the first left the second nothing to rename. Both are sent half
   * way before either finishes.
   */
  it('gives two uploads of the same name at once a name each, with their own content', async () => {
    const destination = await seed();
    const port = await listen(buildApp());

    const first = sendInTwoHalves(port, 'notes.txt', 'a'.repeat(128 * 1024));
    const second = sendInTwoHalves(port, 'notes.txt', 'b'.repeat(128 * 1024));
    // Both are writing before either finishes. The old code shared one
    // temporary between them, so this only waits as long as it has to.
    await waitFor(async () => (await temporaries(destination)).length === 2, 1500);
    first.finish();
    second.finish();
    const answers = await Promise.all([first.response, second.response]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const told = answers.map((answer) => JSON.parse(answer.text)[0].name).sort();
    expect(told).toEqual(['notes (1).txt', 'notes.txt']);
    expect(await listing(destination)).toEqual(['notes (1).txt', 'notes.txt']);
    const contents = await Promise.all(
      told.map((name) => fs.readFile(path.join(destination, name), 'utf8'))
    );
    expect(contents.sort()).toEqual(['a'.repeat(128 * 1024), 'b'.repeat(128 * 1024)]);
  });
});

describe('an upload on its way', () => {
  /**
   * The bytes are written under a hidden name of their own, never under the
   * name the file will take nor beside it as "name.uploading", which the
   * listing showed as a file of its own for the whole transfer.
   */
  it('is written under a hidden name, and a cut upload leaves nothing', async () => {
    const destination = await seed();
    const port = await listen(buildApp());

    const partial = sendInTwoHalves(port, 'holiday.mp4', 'x'.repeat(256 * 1024));
    partial.response.catch(() => {});
    expect(await waitFor(async () => (await temporaries(destination)).length === 1)).toBe(true);
    expect((await listing(destination)).filter((name) => !name.startsWith('.'))).toEqual([]);

    partial.cut();

    expect(await waitFor(async () => (await listing(destination)).length === 0)).toBe(true);
  });

  /**
   * A stop half way used to leave "holiday.mp4.uploading" in the folder for
   * good. The hidden file is recorded while the bytes arrive, so the next
   * start removes it, and the record goes once the upload is over.
   */
  it('is recorded while the bytes arrive, and released once it is over', async () => {
    const destination = await seed();
    const port = await listen(buildApp());
    const journal = path.join(envContext.cacheDir, 'in-flight');
    const records = async () => {
      const names = await fs.readdir(journal).catch(() => []);
      return Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => JSON.parse(await fs.readFile(path.join(journal, name), 'utf8')))
      );
    };

    const partial = sendInTwoHalves(port, 'holiday.mp4', 'x'.repeat(256 * 1024));
    expect(await waitFor(async () => (await temporaries(destination)).length === 1)).toBe(true);
    const [temporary] = await temporaries(destination);
    expect(await records()).toEqual([
      expect.objectContaining({
        path: path.join(destination, temporary),
        kind: 'partial-upload',
      }),
    ]);

    partial.finish();
    expect((await partial.response).status).toBe(200);
    expect(await records()).toEqual([]);
    expect(await listing(destination)).toEqual(['holiday.mp4']);
  });

  it('leaves the next start a hidden file to remove when the process stops half way', async () => {
    const destination = await seed();
    const port = await listen(buildApp());

    const partial = sendInTwoHalves(port, 'holiday.mp4', 'x'.repeat(256 * 1024));
    partial.response.catch(() => {});
    expect(await waitFor(async () => (await temporaries(destination)).length === 1)).toBe(true);

    // The next start: a fresh module, whose run is not the one that wrote.
    const { sweepInterrupted } = envContext.requireFresh('src/services/inFlightFiles');
    expect(sweepInterrupted()).toEqual({ removed: 1 });
    expect(await temporaries(destination)).toEqual([]);
    partial.cut();
  });
});
