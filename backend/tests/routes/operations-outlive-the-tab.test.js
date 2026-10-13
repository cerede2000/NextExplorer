import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A copy belongs to the person who asked for it, not to the tab they asked from.
 *
 * The work used to run inside the request: closing the tab closed the socket,
 * the socket aborted the transfer, and half a folder was left at the destination
 * with nothing said about it. A transfer of twenty gigabytes is not something to
 * hold a tab open for, and "do not close this tab" is not an answer.
 *
 * So the response is a window onto a registered operation. What these tests hold
 * is the whole of that: the work finishes although the window closed, a window
 * can be opened again from another tab, and a window is only ever opened onto
 * one's own operation.
 */

let env;
let server;

const ALICE = { id: 'alice', roles: ['user'] };
const BOB = { id: 'bob', roles: ['user'] };

const volumeDir = (...parts) => path.join(env.volumeDir, ...parts);

// Big enough that a transfer is unmistakably still running an instant after it
// started, which is when the tab goes away below.
const BIG_FILE_BYTES = 32 * 1024 * 1024;

const seed = async () => {
  env = await setupTestEnv({ tag: 'transfer-tab-' });
  const db = await env.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  for (const [id, username] of [
    ['alice', 'alice'],
    ['bob', 'bob'],
  ]) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
    ).run(id, `${username}@example.com`, username, username, now, now);
  }
  await fs.mkdir(volumeDir('Source'), { recursive: true });
  await fs.mkdir(volumeDir('Destination'), { recursive: true });
  await fs.writeFile(volumeDir('Source', 'big.bin'), Buffer.alloc(BIG_FILE_BYTES, 7));
  await fs.writeFile(volumeDir('Source', 'note.txt'), 'a short one\n');
  await fs.writeFile(volumeDir('Source', 'other.txt'), 'another short one\n');
  // Enough entries that a deletion is unmistakably still running an instant
  // after it started, which is when the tab goes away below.
  await fs.mkdir(volumeDir('Heap'), { recursive: true });
  await Promise.all(
    Array.from({ length: 1200 }, (_, index) =>
      fs.writeFile(volumeDir('Heap', `item-${String(index).padStart(5, '0')}.txt`), `${index}\n`)
    )
  );
};

/** The application as a signed-in account reaches it. */
const appFor = (user) => {
  const application = express();
  application.use(express.json({ limit: '2mb' }));
  application.use((req, _res, next) => {
    req.user = user;
    next();
  });
  application.use('/api', env.requireFresh('src/routes/files'));
  application.use('/api', env.requireFresh('src/routes/tasks'));
  application.use(env.requireFresh('src/middleware/errorHandler').errorHandler);
  return application;
};

/**
 * One request, read line by line, that can be cut off at any moment — which is
 * the point: supertest answers whole responses, and what has to be tested here
 * is a response that never finishes.
 */
const openStream = (port, user, endpoint, body) =>
  new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    const payload = body ? JSON.stringify(body) : null;
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        path: endpoint,
        method: body ? 'POST' : 'GET',
        headers: {
          'x-test-user': user.id,
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        let pending = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          pending += chunk;
          for (;;) {
            const breakAt = pending.indexOf('\n');
            if (breakAt < 0) break;
            const line = pending.slice(0, breakAt).trim();
            pending = pending.slice(breakAt + 1);
            if (!line) continue;
            events.push(JSON.parse(line));
            for (const waiter of [...waiters]) waiter();
          }
        });
        resolve({
          status: response.statusCode,
          events,
          /** The tab goes away: the socket is cut, nothing is said. */
          cut: () => outgoing.destroy(),
          waitFor: (type) =>
            new Promise((settle, fail) => {
              const check = () => {
                if (events.some((event) => event.type === type)) {
                  settle(events.find((event) => event.type === type));
                  return true;
                }
                return false;
              };
              if (check()) return;
              waiters.push(() => check());
              setTimeout(() => fail(new Error(`No ${type} event arrived`)), 20000);
            }),
        });
      }
    );
    outgoing.on('error', (error) => {
      // Cutting the connection ourselves is the test, not a failure.
      if (error.code !== 'ECONNRESET') reject(error);
    });
    if (payload) outgoing.end(payload);
    else outgoing.end();
  });

const listen = (application) =>
  new Promise((resolve) => {
    const started = application.listen(0, '127.0.0.1', () => resolve(started));
  });

const tasksOf = async (user) => (await request(appFor(user)).get('/api/tasks')).body;

const settledTask = async (user, taskId) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { items } = await tasksOf(user);
    const found = items.find((task) => task.id === taskId);
    if (found && found.state !== 'running') return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The operation never settled');
};

beforeEach(async () => {
  await seed();
});

afterEach(async () => {
  if (server) {
    // A window left open holds its connection, and `close` waits for every one
    // of them: the tidying up after a test must not wait for a stream the test
    // deliberately never finished.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  server = null;
  if (env) {
    env.requireFresh('src/services/operationTasks').reset();
    await env.cleanup();
    env = null;
  }
});

describe('a transfer whose tab went away', () => {
  it('finishes, and says so to whoever asks later', async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const stream = await openStream(server.address().port, ALICE, '/api/files/copy', {
      items: [{ path: 'Source', name: 'big.bin' }],
      destination: 'Destination',
    });
    const start = await stream.waitFor('start');
    expect(start.taskId).toBeTypeOf('string');
    expect(start.totalBytes).toBe(BIG_FILE_BYTES);

    stream.cut();

    // Still running at the instant the window closed: without this the rest of
    // the test would pass on a copy that had already finished.
    const whileRunning = await tasksOf(ALICE);
    expect(whileRunning.items).toHaveLength(1);
    expect(whileRunning.items[0]).toMatchObject({ id: start.taskId, state: 'running' });

    const settled = await settledTask(ALICE, start.taskId);
    expect(settled.state).toBe('done');
    // How much of it is done, rather than every entry of it: a copy of a hundred
    // thousand files would otherwise answer every page load with all of them.
    expect(settled).toMatchObject({ completedItems: 1, totalItems: 1 });
    expect(settled.result).toBeUndefined();

    const landed = await fs.stat(volumeDir('Destination', 'big.bin'));
    expect(landed.size).toBe(BIG_FILE_BYTES);
    // And nothing half-written was left under a visible name.
    expect((await fs.readdir(volumeDir('Destination'))).sort()).toEqual(['big.bin']);
  });

  it('is watched again by a tab opened later, from where it has got to', async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const first = await openStream(server.address().port, ALICE, '/api/files/copy', {
      items: [{ path: 'Source', name: 'big.bin' }],
      destination: 'Destination',
    });
    const start = await first.waitFor('start');
    first.cut();

    const again = await openStream(
      server.address().port,
      ALICE,
      `/api/tasks/${start.taskId}/stream`,
      null
    );
    expect(again.status).toBe(200);
    const caughtUp = await again.waitFor('start');
    expect(caughtUp).toMatchObject({ taskId: start.taskId, kind: 'copy' });

    const done = await again.waitFor('done');
    expect(done).toMatchObject({ success: true, destination: 'Destination' });
    expect((await fs.stat(volumeDir('Destination', 'big.bin'))).size).toBe(BIG_FILE_BYTES);
  });

  /**
   * The register is the second lock: every handler still runs its own access
   * check before any work is queued. What is left is that one caller's
   * operations are not another's to see, follow or stop — and that asking about
   * an id never says whether it exists.
   */
  it("is not another account's to see, to follow or to stop", async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const stream = await openStream(server.address().port, ALICE, '/api/files/copy', {
      items: [{ path: 'Source', name: 'big.bin' }],
      destination: 'Destination',
    });
    const start = await stream.waitFor('start');

    expect((await tasksOf(BOB)).items).toEqual([]);
    const bobWatching = await request(appFor(BOB)).get(`/api/tasks/${start.taskId}/stream`);
    expect(bobWatching.status).toBe(404);
    const bobStopping = await request(appFor(BOB)).post(`/api/tasks/${start.taskId}/cancel`);
    expect(bobStopping.status).toBe(404);
    // The same answer for an id that names nothing at all.
    const noSuchTask = await request(appFor(ALICE)).post('/api/tasks/not-a-task/cancel');
    expect(noSuchTask.status).toBe(404);

    await stream.waitFor('done');
    expect((await fs.stat(volumeDir('Destination', 'big.bin'))).size).toBe(BIG_FILE_BYTES);
  });

  it('is stopped by asking, which is now the only way to stop one', async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const stream = await openStream(server.address().port, ALICE, '/api/files/copy', {
      items: [{ path: 'Source', name: 'big.bin' }],
      destination: 'Destination',
    });
    const start = await stream.waitFor('start');
    // Bytes are moving: the first progress event is sent on the first one, so
    // there is unmistakably a transfer in flight to stop.
    await stream.waitFor('progress');

    const stopped = await request(appFor(ALICE)).post(`/api/tasks/${start.taskId}/cancel`);
    expect(stopped.status).toBe(200);

    const refusal = await stream.waitFor('error');
    expect(refusal.code).toBe('OPERATION_CANCELLED');
    const settled = await settledTask(ALICE, start.taskId);
    expect(settled.state).toBe('cancelled');

    // Nothing landed under a visible name, and the source is untouched: what
    // was being written was hidden beside its name until it was whole.
    expect((await fs.stat(volumeDir('Source', 'big.bin'))).size).toBe(BIG_FILE_BYTES);
    expect(await fs.readdir(volumeDir('Destination'))).toEqual([]);
  });
});

describe('a selection too large for one request body', () => {
  it('is one operation, and answers once for all of its parts', async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const stream = await openStream(server.address().port, ALICE, '/api/files/copy', {
      items: [{ path: 'Source', name: 'note.txt' }],
      destination: 'Destination',
      continues: true,
    });
    const start = await stream.waitFor('start');

    const rest = await request(appFor(ALICE))
      .post('/api/files/copy')
      .send({
        items: [{ path: 'Source', name: 'other.txt' }],
        destination: 'Destination',
        taskId: start.taskId,
      });
    expect(rest.status).toBe(202);
    expect(rest.body).toEqual({ taskId: start.taskId, accepted: 1 });

    const done = await stream.waitFor('done');
    expect(done.items.map((item) => item.to).sort()).toEqual([
      'Destination/note.txt',
      'Destination/other.txt',
    ]);
    expect((await fs.readdir(volumeDir('Destination'))).sort()).toEqual(['note.txt', 'other.txt']);
  });

  it("refuses a part named for somebody else's operation", async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const stream = await openStream(server.address().port, ALICE, '/api/files/copy', {
      items: [{ path: 'Source', name: 'note.txt' }],
      destination: 'Destination',
      continues: true,
    });
    const start = await stream.waitFor('start');

    const fromBob = await request(appFor(BOB))
      .post('/api/files/copy')
      .send({
        items: [{ path: 'Source', name: 'other.txt' }],
        destination: 'Destination',
        taskId: start.taskId,
      });
    expect(fromBob.status).toBe(404);

    // And nothing of Bob's arrived through Alice's operation.
    await request(appFor(ALICE)).post(`/api/tasks/${start.taskId}/cancel`);
    expect(await fs.readdir(volumeDir('Destination'))).not.toContain('other.txt');
  });
});

describe('a part of a selection that is refused', () => {
  /**
   * The caller has just been told it cannot send that part, so no part of it is
   * coming: the operation finishes on what it received rather than holding the
   * reader's window open waiting for the rest.
   */
  it('ends the operation rather than leaving it waiting for the rest', async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const stream = await openStream(server.address().port, ALICE, '/api/files/copy', {
      items: [{ path: 'Source', name: 'note.txt' }],
      destination: 'Destination',
      continues: true,
    });
    const start = await stream.waitFor('start');

    const refused = await request(appFor(ALICE))
      .post('/api/files/copy')
      .send({
        items: [{ path: 'Source', name: 'missing.bin' }],
        destination: 'Destination',
        taskId: start.taskId,
      });
    expect(refused.status).toBe(404);

    const done = await stream.waitFor('done');
    expect(done.items.map((item) => item.to)).toEqual(['Destination/note.txt']);
    expect((await settledTask(ALICE, start.taskId)).state).toBe('done');
  });
});

describe('a transfer that is refused', () => {
  it('is an ordinary HTTP error, with no operation left behind', async () => {
    const refused = await request(appFor(ALICE))
      .post('/api/files/copy')
      .send({ items: [], destination: 'Destination' });

    expect(refused.status).toBe(400);
    expect((await tasksOf(ALICE)).items).toEqual([]);
  });

  it('is an ordinary HTTP error for a source that is not there', async () => {
    const refused = await request(appFor(ALICE))
      .post('/api/files/copy')
      .send({ items: [{ path: 'Source', name: 'missing.bin' }], destination: 'Destination' });

    expect(refused.status).toBe(404);
    expect((await tasksOf(ALICE)).items).toEqual([]);
  });
});

/**
 * The same of a deletion, which is the other operation a reader starts on a
 * selection rather than on one thing — and the other one that used to be aborted
 * by its own socket, leaving half a selection gone and nothing saying which half.
 */
describe('a deletion whose tab went away', () => {
  it('finishes, and says so to whoever asks later', async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const names = await fs.readdir(volumeDir('Heap'));
    const stream = await openStream(server.address().port, ALICE, '/api/files/delete-stream', {
      items: names.map((name) => ({ path: 'Heap', name })),
      permanent: true,
    });
    const start = await stream.waitFor('start');
    expect(start.taskId).toBeTypeOf('string');
    expect(start.totalItems).toBe(1200);

    stream.cut();

    // Still running at the instant the window closed: without this the rest of
    // the test would pass on a deletion that had already finished.
    const whileRunning = await tasksOf(ALICE);
    expect(whileRunning.items).toHaveLength(1);
    expect(whileRunning.items[0]).toMatchObject({ id: start.taskId, state: 'running' });

    const settled = await settledTask(ALICE, start.taskId);
    expect(settled.state).toBe('done');
    expect(settled).toMatchObject({ completedItems: 1200, totalItems: 1200 });
    expect(await fs.readdir(volumeDir('Heap'))).toEqual([]);
  });

  it('is one operation however many parts the selection was sent in', async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const names = (await fs.readdir(volumeDir('Heap'))).slice(0, 4);
    const stream = await openStream(server.address().port, ALICE, '/api/files/delete-stream', {
      items: [{ path: 'Heap', name: names[0] }],
      permanent: true,
      continues: true,
    });
    const start = await stream.waitFor('start');

    const rest = await request(appFor(ALICE))
      .post('/api/files/delete-stream')
      .send({
        items: names.slice(1).map((name) => ({ path: 'Heap', name })),
        permanent: true,
        taskId: start.taskId,
      });
    expect(rest.status).toBe(202);
    expect(rest.body).toEqual({ taskId: start.taskId, accepted: 3 });

    const done = await stream.waitFor('done');
    expect(done.items.map((item) => item.status)).toEqual([
      'deleted',
      'deleted',
      'deleted',
      'deleted',
    ]);
    for (const name of names) {
      await expect(fs.stat(volumeDir('Heap', name))).rejects.toThrow();
    }
  });

  it('is not another account\u2019s to stop', async () => {
    const application = appFor(ALICE);
    server = await listen(application);

    const names = await fs.readdir(volumeDir('Heap'));
    const stream = await openStream(server.address().port, ALICE, '/api/files/delete-stream', {
      items: names.map((name) => ({ path: 'Heap', name })),
      permanent: true,
    });
    const start = await stream.waitFor('start');

    expect((await request(appFor(BOB)).post(`/api/tasks/${start.taskId}/cancel`)).status).toBe(404);
    expect((await request(appFor(ALICE)).post(`/api/tasks/${start.taskId}/cancel`)).status).toBe(
      200
    );

    const settled = await settledTask(ALICE, start.taskId);
    expect(settled.state).toBe('cancelled');
    // What it had already removed is gone; the rest is still there.
    expect((await fs.readdir(volumeDir('Heap'))).length).toBeGreaterThan(0);
  });
});
