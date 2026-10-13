import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Operations that belong to the person who asked, not to the tab they asked from.
 *
 * A copy used to run inside its own request: closing the tab aborted the socket,
 * the socket aborted the transfer, and half a folder was left at the destination
 * with nothing said. The work is registered here instead and the request is only
 * a window onto it — so what this has to hold is that the work outlives the
 * window, and that a window is only ever opened by the owner of what it shows.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const setup = async () => {
  envContext = await setupTestEnv({ tag: 'operation-tasks-' });
  // Before the register, so that the instance the register holds is this one:
  // two AsyncLocalStorage objects would make the detachment below unobservable
  // rather than untrue.
  const requestContext = envContext.requireFresh('src/utils/requestContext');
  const tasks = envContext.requireFresh('src/services/operationTasks');
  return { tasks, requestContext, journal: path.join(envContext.cacheDir, 'tasks') };
};

const alice = { type: 'user', id: 'alice' };
const bob = { type: 'user', id: 'bob' };
const visitor = { type: 'guest', id: 'guest-1' };

const records = (journal) =>
  fs.existsSync(journal) ? fs.readdirSync(journal).filter((name) => name.endsWith('.json')) : [];

/** A task with one unit of work that settles when the test says so. */
const openHeldTask = (tasks, owner = alice, extra = {}) => {
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const bag = { ran: 0 };
  const handle = tasks.open({
    kind: 'copy',
    owner,
    destination: 'Projects/Dropbox',
    bag,
    collect: () => ({ destination: 'Projects/Dropbox', items: [{ to: 'report.txt' }] }),
    ...extra,
  });
  handle.grow({ totalItems: 1, totalBytes: 100, names: ['Docs/report.txt'] });
  handle.enqueue(async () => {
    bag.ran += 1;
    await held;
    handle.advance({ items: 1, bytes: 100 });
  });
  return { handle, release, bag };
};

describe('an operation of the person who asked for it', () => {
  it('finishes although the window onto it was closed', async () => {
    const { tasks } = await setup();
    const { handle, release, bag } = openHeldTask(tasks);

    const seen = [];
    const detach = tasks.watch(handle.id, alice, {}, (event) => seen.push(event.type));
    expect(seen).toEqual(['start']);

    // The tab goes away: the only thing that ends is the watching.
    detach();
    handle.seal();
    release();
    const view = await handle.settled;

    expect(bag.ran).toBe(1);
    expect(view.state).toBe('done');
    expect(seen).toEqual(['start']);

    // What it did is not in how a task is listed — every page load asks for
    // that — it is on the task's own stream, which is where a window opened
    // afterwards reads it.
    expect(view.result).toBeUndefined();
    const later = [];
    tasks.watch(handle.id, alice, {}, (event) => later.push(event));
    expect(later.at(-1)).toMatchObject({
      type: 'done',
      success: true,
      items: [{ to: 'report.txt' }],
    });
  });

  it('is caught up, then followed, by a window opened later', async () => {
    const { tasks } = await setup();
    const { handle, release } = openHeldTask(tasks);

    const seen = [];
    tasks.watch(handle.id, alice, {}, (event) => seen.push(event));
    const start = seen.at(0);
    expect(start).toMatchObject({
      type: 'start',
      taskId: handle.id,
      kind: 'copy',
      destination: 'Projects/Dropbox',
      totalBytes: 100,
      totalItems: 1,
    });

    handle.report({ unitBytes: 40, currentName: 'report.txt' });
    handle.seal();
    release();
    await handle.settled;

    expect(seen.map((event) => event.type)).toEqual(['start', 'progress', 'done']);
    expect(seen.at(1)).toMatchObject({ copiedBytes: 40, totalBytes: 100 });
    expect(seen.at(-1)).toMatchObject({ type: 'done', success: true });
  });

  /**
   * The register is the second lock, and this is the one it holds: a handler
   * runs its own access check before any work is queued, so a task can never do
   * more than its owner may. What is left is telling one caller's tasks from
   * another's — including never saying whether an id exists at all.
   */
  it('is invisible to anybody else, who cannot watch or stop it either', async () => {
    const { tasks } = await setup();
    const { handle, release } = openHeldTask(tasks);

    expect(tasks.listFor(bob, {})).toEqual([]);
    expect(tasks.find(handle.id, bob, {})).toBeNull();
    expect(tasks.watch(handle.id, bob, {}, () => {})).toBeNull();
    expect(tasks.cancel(handle.id, bob, {})).toBe(false);
    expect(
      tasks.reopen(handle.id, bob, { kind: 'copy', destination: 'Projects/Dropbox' })
    ).toBeNull();

    // An id that names nothing answers exactly as one that is not yours.
    expect(tasks.watch('no-such-task', alice, {}, () => {})).toBeNull();
    expect(tasks.cancel('no-such-task', alice, {})).toBe(false);

    release();
    handle.seal();
    await handle.settled;
    expect(tasks.listFor(alice, {}).at(0)).toMatchObject({ state: 'done' });
  });

  // A guest session is issued for one share. What a visitor started inside one
  // is not theirs to see from the prefix of another.
  it('stays inside the share it was started in', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({
      kind: 'copy',
      owner: visitor,
      shareId: 'share-a',
      destination: 'Dropbox',
    });

    expect(tasks.listFor(visitor, { shareId: 'share-a' })).toHaveLength(1);
    expect(tasks.listFor(visitor, { shareId: 'share-b' })).toEqual([]);
    expect(tasks.listFor(visitor, {})).toEqual([]);
    expect(tasks.watch(handle.id, visitor, { shareId: 'share-b' }, () => {})).toBeNull();
    expect(tasks.cancel(handle.id, visitor, { shareId: null })).toBe(false);
  });

  // Two identifier spaces that have nothing to do with each other: an account
  // id that happens to spell a session id is still somebody else.
  it('does not confuse an account with a visitor of the same name', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({
      kind: 'copy',
      owner: { type: 'user', id: 'same-name' },
      destination: 'Dropbox',
    });

    expect(tasks.find(handle.id, { type: 'guest', id: 'same-name' }, {})).toBeNull();
  });

  it('refuses to exist without an owner', async () => {
    const { tasks } = await setup();

    expect(() => tasks.open({ kind: 'copy', owner: null, destination: 'x' })).toThrow(/owner/i);
    expect(() => tasks.open({ kind: 'copy', owner: { type: 'user' }, destination: 'x' })).toThrow(
      /owner/i
    );
  });
});

describe('a selection too large for one request body', () => {
  it('grows the same task, and only for the same operation into the same folder', async () => {
    const { tasks } = await setup();
    const { handle, release } = openHeldTask(tasks);

    const again = tasks.reopen(handle.id, alice, {
      kind: 'copy',
      destination: 'Projects/Dropbox',
    });
    expect(again).not.toBeNull();
    again.grow({ totalItems: 2, totalBytes: 300 });
    expect(tasks.find(handle.id, alice, {})).toMatchObject({ totalItems: 3, totalBytes: 400 });

    expect(
      tasks.reopen(handle.id, alice, { kind: 'move', destination: 'Projects/Dropbox' })
    ).toBeNull();
    expect(tasks.reopen(handle.id, alice, { kind: 'copy', destination: 'Elsewhere' })).toBeNull();

    release();
    handle.seal();
    await handle.settled;
    expect(
      tasks.reopen(handle.id, alice, { kind: 'copy', destination: 'Projects/Dropbox' })
    ).toBeNull();
  });

  /**
   * One unit at a time, which is a requirement rather than a simplification: a
   * destination name is taken by checking that it is free and then using it, and
   * two units placing things in the same folder would both find it free.
   */
  it('never runs two of its parts at once', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({ kind: 'copy', owner: alice, destination: 'Dropbox' });

    let inside = 0;
    let both = false;
    const unit = async () => {
      inside += 1;
      if (inside > 1) both = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
    };
    handle.enqueue(unit);
    handle.enqueue(unit);
    handle.enqueue(unit);
    handle.seal();
    await handle.settled;

    expect(both).toBe(false);
  });

  // The word that the last part has been sent may never come, because the tab
  // that was sending went away. The queue closes on what it received.
  it('closes itself when it is never told it is complete', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({
      kind: 'copy',
      owner: alice,
      destination: 'Dropbox',
      collect: () => ({ destination: 'Dropbox', items: [] }),
      // The real wait is half a minute; what is under test is that the wait
      // ends, not how long it is.
      sealWithin: 30,
    });
    handle.enqueue(async () => {});

    // Not sealed: it is waiting for the rest of a selection that is not coming.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tasks.find(handle.id, alice, {}).state).toBe('running');

    expect((await handle.settled).state).toBe('done');
  });
});

describe('stopping an operation', () => {
  it('aborts what it is doing and says it was cancelled', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({ kind: 'copy', owner: alice, destination: 'Dropbox' });

    let aborted = false;
    handle.enqueue(async () => {
      await new Promise((resolve) => {
        handle.signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
      const error = new Error('Operation cancelled.');
      error.code = 'OPERATION_CANCELLED';
      throw error;
    });

    const seen = [];
    tasks.watch(handle.id, alice, {}, (event) => seen.push(event));
    expect(tasks.cancel(handle.id, alice, {})).toBe(true);
    const view = await handle.settled;

    expect(aborted).toBe(true);
    expect(view.state).toBe('cancelled');
    expect(seen.at(-1)).toMatchObject({ type: 'error', code: 'OPERATION_CANCELLED' });
  });

  it('reports a failure in the words the caller is allowed to read', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({ kind: 'copy', owner: alice, destination: 'Dropbox' });

    handle.enqueue(
      async () => {
        throw new Error('EACCES: /srv/volume/secret');
      },
      () => ({ message: 'Transfer failed.', code: 'TRANSFER_FAILED' })
    );
    handle.seal();
    const view = await handle.settled;

    expect(view.state).toBe('failed');
    expect(view.error).toEqual({ message: 'Transfer failed.', code: 'TRANSFER_FAILED' });
  });

  it('refuses to hold more than its share of running operations', async () => {
    const { tasks } = await setup();
    const held = [];
    for (let index = 0; index < tasks.MAX_RUNNING_PER_OWNER; index += 1) {
      held.push(openHeldTask(tasks));
    }

    expect(() => tasks.open({ kind: 'copy', owner: alice, destination: 'x' })).toThrow(/too many/i);
    // Somebody else is not affected by what this account is doing.
    expect(() => tasks.open({ kind: 'copy', owner: bob, destination: 'x' })).not.toThrow();

    for (const one of held) {
      one.release();
      one.handle.seal();
    }
    await Promise.all(held.map((one) => one.handle.settled));
  });

  it('refuses to be watched from everywhere at once', async () => {
    const { tasks } = await setup();
    const { handle, release } = openHeldTask(tasks);

    for (let index = 0; index < tasks.MAX_WATCHERS_PER_TASK; index += 1) {
      expect(tasks.watch(handle.id, alice, {}, () => {})).toBeTypeOf('function');
    }
    expect(() => tasks.watch(handle.id, alice, {}, () => {})).toThrow(/too many/i);

    release();
    handle.seal();
    await handle.settled;
  });
});

describe('what a restart took', () => {
  it('is recorded while it runs and released when it ends', async () => {
    const { tasks, journal } = await setup();
    const { handle, release } = openHeldTask(tasks);

    expect(records(journal)).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(journal, records(journal)[0]), 'utf8'));
    expect(written).toMatchObject({
      kind: 'copy',
      destination: 'Projects/Dropbox',
      paths: ['Docs/report.txt'],
      owner: alice,
    });

    release();
    handle.seal();
    await handle.settled;
    expect(records(journal)).toHaveLength(0);
  });

  it('is reported to its owner, with the paths, and to nobody else', async () => {
    const { tasks, journal } = await setup();
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(
      path.join(journal, 'lost-1.json'),
      JSON.stringify({
        id: 'lost-1',
        runId: 'an-earlier-run',
        kind: 'move',
        owner: alice,
        shareId: null,
        destination: 'Archive/2026',
        paths: ['Docs/report.txt', 'Docs/plan.md'],
        startedAt: '2026-10-01T10:00:00Z',
      })
    );

    expect(tasks.reportInterrupted()).toEqual({ interrupted: 1 });
    expect(tasks.interruptedFor(alice, null)).toEqual([
      {
        id: 'lost-1',
        kind: 'move',
        destination: 'Archive/2026',
        paths: ['Docs/report.txt', 'Docs/plan.md'],
        startedAt: '2026-10-01T10:00:00Z',
        interruptedAt: expect.any(String),
      },
    ]);
    expect(tasks.interruptedFor(bob, null)).toEqual([]);
    expect(tasks.interruptedFor(alice, 'share-a')).toEqual([]);

    // Stamped, so the next start does not log it a second time.
    const kept = JSON.parse(fs.readFileSync(path.join(journal, 'lost-1.json'), 'utf8'));
    expect(kept.interruptedAt).toBeTypeOf('string');

    expect(tasks.forgetInterrupted(bob, null, [])).toEqual({ forgotten: 0 });
    expect(records(journal)).toHaveLength(1);
    expect(tasks.forgetInterrupted(alice, null, [])).toEqual({ forgotten: 1 });
    expect(records(journal)).toHaveLength(0);
    expect(tasks.interruptedFor(alice, null)).toEqual([]);
  });

  it('leaves the records of this very run alone', async () => {
    const { tasks, journal } = await setup();
    const { handle, release } = openHeldTask(tasks);

    expect(tasks.reportInterrupted()).toEqual({ interrupted: 0 });
    expect(records(journal)).toHaveLength(1);
    expect(tasks.interruptedFor(alice, null)).toEqual([]);

    release();
    handle.seal();
    await handle.settled;
  });
});

/**
 * A task is not a request, and this is why it must not look like one.
 *
 * Path containment resolves real paths and memoizes them for the rest of the
 * request, which is correct for a request and wrong for an operation that runs
 * for half an hour: the cache feeds a security check, and the one it inherited
 * was taken when the tab was still open.
 */
describe('an operation that outlives its request', () => {
  it("carries none of that request's path cache", async () => {
    const { tasks, requestContext } = await setup();
    const { runInRequestContext, hasRequestContext } = requestContext;

    let insideTheRequest = null;
    let insideTheTask = null;
    const done = runInRequestContext(async () => {
      insideTheRequest = hasRequestContext();
      const handle = tasks.open({ kind: 'copy', owner: alice, destination: 'Dropbox' });
      handle.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        insideTheTask = hasRequestContext();
      });
      handle.seal();
      return handle.settled;
    });
    await done;

    expect(insideTheRequest).toBe(true);
    expect(insideTheTask).toBe(false);
  });
});
