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

describe('what an operation is about', () => {
  /**
   * A name rather than a folder, for the operations that have one: the archive
   * being unpacked, the name a new one will take. That name is decided while
   * the work runs — an archive takes the first one nothing holds — so it is
   * said again once it is known, rather than left as the one asked for.
   */
  it('says the name it was given, and the one it ends up with', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({
      kind: 'compress',
      owner: alice,
      destination: 'Dropbox',
      label: 'Archive.zip',
      collect: () => ({}),
    });

    const seen = [];
    tasks.watch(handle.id, alice, {}, (event) => seen.push(event));
    expect(seen.at(0)).toMatchObject({ type: 'start', name: 'Archive.zip' });
    expect(tasks.find(handle.id, alice, {}).label).toBe('Archive.zip');

    handle.rename('Archive (1).zip');
    expect(seen.at(-1)).toMatchObject({ type: 'progress', name: 'Archive (1).zip' });
    expect(tasks.listFor(alice, {}).at(0).name).toBe('Archive (1).zip');

    handle.seal();
    await handle.settled;
  });

  /**
   * And how far it has got, where that is a percentage and nothing else: an
   * archive reports no bytes and no entry count, so what it says about itself
   * is the only figure there is.
   */
  it('passes on a percentage when that is all the work can say', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({ kind: 'extract', owner: alice, destination: 'Dropbox' });

    const seen = [];
    tasks.watch(handle.id, alice, {}, (event) => seen.push(event));
    handle.report({ percent: 42 });

    expect(seen.at(-1)).toMatchObject({ type: 'progress', percent: 42 });
    expect(tasks.listFor(alice, {}).at(0).percent).toBe(42);

    handle.seal();
    await handle.settled;
  });

  // Entries, for the work that moves entries rather than bytes.
  it('counts the entries a part has got through while it runs', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({ kind: 'delete', owner: alice, destination: '' });
    handle.grow({ totalItems: 4, bytesKnown: false });

    const seen = [];
    tasks.watch(handle.id, alice, {}, (event) => seen.push(event));
    handle.report({ unitItems: 3 });

    expect(seen.at(-1)).toMatchObject({ type: 'progress', completedItems: 3, percent: 75 });

    handle.seal();
    await handle.settled;
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

  /**
   * And takes the rest of the queue with it.
   *
   * A selection sent in several parts is one operation, and the parts after a
   * failure are not "the next one to try": the first one failed for a reason
   * that holds for the rest, and carrying on would be deleting after the reader
   * was told the deletion had failed.
   */
  it('drops what was queued behind a part that failed', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({ kind: 'delete', owner: alice, destination: 'Dropbox' });
    const ran = [];

    handle.enqueue(async () => {
      ran.push('first');
      throw new Error('no');
    });
    handle.enqueue(async () => ran.push('second'));
    handle.enqueue(async () => ran.push('third'));
    handle.seal();

    expect((await handle.settled).state).toBe('failed');
    expect(ran).toEqual(['first']);
    // And nothing can be added to it afterwards, which is what a part still on
    // its way is told.
    expect(handle.enqueue(async () => ran.push('late'))).toBe(false);
    expect(ran).toEqual(['first']);
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
  it('is recorded while it runs, and released once somebody has been told', async () => {
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

    // Somebody is watching, so the end of it is news they are given at once.
    tasks.watch(handle.id, alice, {}, () => {});
    release();
    handle.seal();
    await handle.settled;
    expect(records(journal)).toHaveLength(0);
    expect(tasks.untoldFor(alice, null).unreported).toEqual([]);
  });

  /**
   * And kept when nobody was.
   *
   * It is the other half of an operation outliving its tab: it also *ends* out
   * of sight. An end nobody saw is an end nobody was told about, so what became
   * of it waits with the rest of the news.
   */
  it('keeps what ended with no window open on it, and hands it over once', async () => {
    const { tasks, journal } = await setup();
    const { handle, release } = openHeldTask(tasks);

    release();
    handle.seal();
    await handle.settled;

    expect(records(journal)).toHaveLength(1);
    expect(tasks.untoldFor(alice, null)).toMatchObject({
      interrupted: [],
      unreported: [
        {
          id: handle.id,
          kind: 'copy',
          outcome: 'done',
          destination: 'Projects/Dropbox',
          items: 1,
        },
      ],
    });
    expect(tasks.untoldFor(bob, null).unreported).toEqual([]);

    expect(tasks.forgetUntold(alice, null, [handle.id])).toEqual({ forgotten: 1 });
    expect(tasks.untoldFor(alice, null).unreported).toEqual([]);
    expect(records(journal)).toHaveLength(0);
  });

  it('keeps a failure the same way, which is news worth more than a success', async () => {
    const { tasks } = await setup();
    const handle = tasks.open({ kind: 'copy', owner: alice, destination: 'Dropbox' });
    handle.enqueue(
      async () => {
        throw new Error('no room');
      },
      () => ({ message: 'Transfer failed.', code: 'TRANSFER_FAILED' })
    );
    handle.seal();
    await handle.settled;

    expect(tasks.untoldFor(alice, null).unreported).toMatchObject([
      { kind: 'copy', outcome: 'failed' },
    ]);
  });

  // A cancellation is not news: it is what its owner asked for, wherever from.
  it('says nothing about an operation its owner stopped', async () => {
    const { tasks, journal } = await setup();
    const handle = tasks.open({ kind: 'copy', owner: alice, destination: 'Dropbox' });
    handle.enqueue(async () => {
      await new Promise((resolve) => handle.signal.addEventListener('abort', resolve));
      const stopped = new Error('Operation cancelled.');
      stopped.code = 'OPERATION_CANCELLED';
      throw stopped;
    });

    expect(tasks.cancel(handle.id, alice, {})).toBe(true);
    expect((await handle.settled).state).toBe('cancelled');

    expect(tasks.untoldFor(alice, null).unreported).toEqual([]);
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

    expect(tasks.reportInterrupted()).toEqual({ interrupted: 1, unreported: 0 });
    expect(tasks.untoldFor(alice, null).interrupted).toEqual([
      {
        id: 'lost-1',
        kind: 'move',
        destination: 'Archive/2026',
        paths: ['Docs/report.txt', 'Docs/plan.md'],
        startedAt: '2026-10-01T10:00:00Z',
      },
    ]);
    expect(tasks.untoldFor(bob, null).interrupted).toEqual([]);
    expect(tasks.untoldFor(alice, 'share-a').interrupted).toEqual([]);

    // Stamped, so the next start does not log it a second time.
    const kept = JSON.parse(fs.readFileSync(path.join(journal, 'lost-1.json'), 'utf8'));
    expect(kept.noticedAt).toBeTypeOf('string');

    expect(tasks.forgetUntold(bob, null, [])).toEqual({ forgotten: 0 });
    expect(records(journal)).toHaveLength(1);
    expect(tasks.forgetUntold(alice, null, [])).toEqual({ forgotten: 1 });
    expect(records(journal)).toHaveLength(0);
    expect(tasks.untoldFor(alice, null).interrupted).toEqual([]);
  });

  it('tells an outcome an earlier run never got to report', async () => {
    const { tasks, journal } = await setup();
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(
      path.join(journal, 'ended-1.json'),
      JSON.stringify({
        id: 'ended-1',
        runId: 'an-earlier-run',
        kind: 'compress',
        owner: alice,
        shareId: null,
        destination: 'Archive',
        name: 'bundle.zip',
        paths: [],
        startedAt: '2026-10-01T10:00:00Z',
        outcome: 'done',
        items: 3,
        finishedAt: '2026-10-01T10:04:00Z',
      })
    );

    expect(tasks.reportInterrupted()).toEqual({ interrupted: 0, unreported: 1 });
    expect(tasks.untoldFor(alice, null)).toMatchObject({
      interrupted: [],
      unreported: [{ id: 'ended-1', kind: 'compress', outcome: 'done', name: 'bundle.zip' }],
    });
  });

  it('leaves the records of this very run alone', async () => {
    const { tasks, journal } = await setup();
    const { handle, release } = openHeldTask(tasks);

    expect(tasks.reportInterrupted()).toEqual({ interrupted: 0, unreported: 0 });
    expect(records(journal)).toHaveLength(1);
    expect(tasks.untoldFor(alice, null).interrupted).toEqual([]);

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
