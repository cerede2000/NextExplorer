const fs = require('fs');
const path = require('path');

const { directories } = require('../config/index');
const { generateId } = require('../utils/ids');
const { runDetached } = require('../utils/requestContext');
const logger = require('../utils/logger');
const { RateLimitError } = require('../errors/AppError');

/**
 * Operations that belong to the person who asked, not to the tab they asked from.
 *
 * A copy used to live and die with its request: the work ran inside the handler,
 * and closing the tab aborted the socket, which aborted the transfer. Half of a
 * folder arrived at the destination and nothing said so. The same was true of
 * everything that streams its progress — a move, a deletion, an archive — and
 * for a transfer measured in minutes, "do not close this tab" is not an answer.
 *
 * So the work is registered here and the request is only a window onto it. The
 * handler opens a task, hands it the units of work, and streams what the task
 * reports; when that connection goes away the task keeps going, and a tab opened
 * later asks for the tasks of whoever is asking and watches them again.
 *
 * Two rules hold this together, and both are about who is asking:
 *
 *  - A task has an owner, which is an account or a visitor's guest session, and
 *    is only ever listed, watched or cancelled by that owner. The register is
 *    the second lock: every handler still runs its own access check before any
 *    work is queued, so a task can never carry more than its owner may do.
 *  - A task opened inside a share stays inside it. A visitor's session is good
 *    for one share, and a task of theirs is answered only under that share.
 *
 * Nothing survives a restart, deliberately: a half-finished copy is a state on
 * disk, and resuming one from a record would mean deciding what to do with what
 * is already there. What a stop interrupted is written down instead — kind,
 * destination and the paths involved — logged at the next start, and handed once
 * to whoever launched it.
 */

/** How long a settled task stays readable, so a tab opened later still sees it. */
const RETAIN_SETTLED_MS = 5 * 60 * 1000;

/**
 * How long a task whose queue has run dry waits for the rest of itself.
 *
 * A large selection is sent as several requests — one body holding every path
 * is refused as too large — and they all name the same task. The task is open
 * until the caller says the last one has been sent; if that word never comes
 * because the tab went away mid-send, this is how long it waits before closing
 * the queue on what it has.
 */
const SEAL_WITHIN_MS = 30 * 1000;

/** Tasks one owner may have running at once. */
const MAX_RUNNING_PER_OWNER = 10;

/** Connections one task may be watched through at once. */
const MAX_WATCHERS_PER_TASK = 8;

/** Source paths kept in the record a restart leaves behind. */
const MAX_RECORDED_PATHS = 10;

/** Interrupted reports nobody collected are dropped after this. */
const RETAIN_INTERRUPTED_MS = 7 * 24 * 60 * 60 * 1000;

// Records written by this process belong to tasks of this run.
const RUN_ID = generateId();

const tasks = new Map();

/** Reports of tasks an earlier run was carrying, read once at start. */
let interrupted = [];

const journalDirectory = () => path.join(directories.cache, 'tasks');

/**
 * Who a request is, for the purpose of owning a task.
 *
 * An account and a guest session are separate kinds on purpose: the two
 * identifier spaces are unrelated, and a task must never be reachable because
 * one happened to spell the other. A caller that is neither owns nothing.
 */
const ownerOf = (req) => {
  if (req?.user?.id) return { type: 'user', id: String(req.user.id) };
  if (req?.guestSession?.id) return { type: 'guest', id: String(req.guestSession.id) };
  return null;
};

const ownerKey = (owner) => (owner?.type && owner?.id ? `${owner.type}:${owner.id}` : null);

const sameOwner = (a, b) => {
  const left = ownerKey(a);
  return Boolean(left) && left === ownerKey(b);
};

/**
 * Whether this caller is allowed to know that this task exists.
 *
 * The share is part of the question, not a detail: a visitor's session belongs
 * to one share, and a task opened under one share is not theirs to see under
 * another. A task opened outside any share answers only outside one.
 */
const visibleTo = (task, owner, shareId = null) =>
  Boolean(task) &&
  sameOwner(task.owner, owner) &&
  String(task.shareId ?? '') === String(shareId ?? '');

const percentOf = (task) => {
  // What the work itself says about one thing of unknown size is the only
  // honest figure there is: an archive being unpacked or packed reports nothing
  // else, and neither does a native copy of a single large file. Several things
  // and how many are done says more than how far into one of them we are.
  if (task.nativePercent != null && task.totalItems <= 1) return task.nativePercent;
  if (task.bytesKnown) return null;
  if (!task.totalItems) return null;
  return Math.round((task.completedItems / task.totalItems) * 100);
};

/**
 * What a task looks like from outside: no handles, no paths it was not asked for.
 *
 * Not what it did, either, however it ended. Every page load asks for the
 * running ones, and a copy of a hundred thousand files would answer that with a
 * hundred thousand entries — once per page, for the five minutes a settled task
 * is kept. What it did is on its own stream, in the `done` event, which is where
 * whoever was watching reads it; here, how much of it is done says enough.
 */
const publicView = (task) => ({
  id: task.id,
  kind: task.kind,
  state: task.state,
  destination: task.destination,
  name: task.label,
  itemNames: task.itemNames.slice(0, 3),
  totalItems: task.totalItems,
  completedItems: task.completedItems,
  totalBytes: task.bytesKnown ? task.totalBytes : 0,
  copiedBytes: task.copiedBytes,
  currentName: task.currentName,
  percent: percentOf(task),
  startedAt: task.startedAt,
  finishedAt: task.finishedAt,
  ...(task.error ? { error: task.error } : {}),
});

/** The event a watcher is caught up with, built from where the task is now. */
const startEvent = (task) => ({
  type: 'start',
  taskId: task.id,
  kind: task.kind,
  destination: task.destination,
  // What the operation is about, where that is a name rather than a folder: the
  // archive being unpacked, the name a new one will take. The server may change
  // that name to one nothing holds, which is why it is said here rather than
  // assumed from what was asked.
  ...(task.label ? { name: task.label } : {}),
  totalBytes: task.bytesKnown ? task.totalBytes : 0,
  totalItems: task.totalItems,
  copiedBytes: task.copiedBytes,
  completedItems: task.completedItems,
  ...(percentOf(task) != null ? { percent: percentOf(task) } : {}),
});

const finalEvent = (task) => {
  if (task.state === 'done') return { type: 'done', success: true, ...task.result };
  return {
    type: 'error',
    message: task.error?.message || 'Operation failed.',
    code: task.error?.code || 'OPERATION_FAILED',
  };
};

const progressNumbers = (task) => ({
  copiedBytes: task.copiedBytes,
  totalBytes: task.bytesKnown ? task.totalBytes : 0,
  completedItems: task.completedItems,
  totalItems: task.totalItems,
  currentName: task.currentName,
  ...(percentOf(task) != null ? { percent: percentOf(task) } : {}),
});

const tell = (task, event) => {
  for (const watcher of [...task.watchers]) {
    try {
      watcher(event);
    } catch (error) {
      logger.debug({ err: error, taskId: task.id }, 'A task watcher could not be told');
    }
  }
};

// ---------------------------------------------------------------------------
// What a stop leaves behind
// ---------------------------------------------------------------------------

const recordPath = (id) => path.join(journalDirectory(), `${id}.json`);

/**
 * Write down what this task is about, so a stop in the middle of it is not
 * silent. Never throws: a task must not fail because it could not be recorded.
 */
const record = (task) => {
  try {
    fs.mkdirSync(journalDirectory(), { recursive: true });
    fs.writeFileSync(
      recordPath(task.id),
      JSON.stringify({
        id: task.id,
        runId: RUN_ID,
        kind: task.kind,
        owner: task.owner,
        shareId: task.shareId ?? null,
        destination: task.destination,
        paths: task.itemNames.slice(0, MAX_RECORDED_PATHS),
        startedAt: new Date(task.startedAt).toISOString(),
      })
    );
  } catch (error) {
    logger.debug({ err: error, taskId: task.id }, 'Could not record a running operation');
  }
};

const releaseRecord = (task) => {
  try {
    fs.rmSync(recordPath(task.id), { force: true });
  } catch (error) {
    logger.debug({ err: error, taskId: task.id }, 'Could not release an operation record');
  }
};

/** Add what a task has grown by to the record, so the report names all of it. */
const updateRecord = (task) => {
  if (task.state !== 'running') return;
  record(task);
};

/**
 * Read what an earlier run was carrying, log it, and keep it for its owner.
 *
 * Called at start, before anything else writes. A record of this run is one of
 * ours and is left alone — nothing here ever runs twice in one process, but a
 * record is a file and files outlive the code that wrote them.
 */
const reportInterrupted = () => {
  let names;
  try {
    names = fs.readdirSync(journalDirectory());
  } catch {
    return { interrupted: 0 };
  }

  const collected = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(journalDirectory(), name);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.runId === RUN_ID) continue;

      const interruptedAt = data.interruptedAt || new Date().toISOString();
      if (Date.parse(interruptedAt) < Date.now() - RETAIN_INTERRUPTED_MS) {
        fs.rmSync(file, { force: true });
        continue;
      }

      const report = { ...data, interruptedAt };
      collected.push(report);

      // Logged once, when it is first noticed: a report kept for an owner who
      // never comes back would otherwise be logged again at every start.
      if (!data.interruptedAt) {
        logger.warn(
          {
            taskId: report.id,
            kind: report.kind,
            destination: report.destination,
            paths: report.paths,
            startedAt: report.startedAt,
          },
          'An operation was interrupted by a stop and did not finish'
        );
        fs.writeFileSync(file, JSON.stringify(report));
      }
    } catch (error) {
      logger.warn({ err: error, file }, 'Could not read the record of an interrupted operation');
      fs.rmSync(file, { force: true });
    }
  }

  interrupted = collected;
  if (collected.length > 0) {
    logger.info(
      { interrupted: collected.length },
      'Operations interrupted by a stop are waiting to be reported'
    );
  }
  return { interrupted: collected.length };
};

/** What was interrupted, as its owner may see it. */
const interruptedFor = (owner, shareId = null) =>
  interrupted
    .filter(
      (report) =>
        sameOwner(report.owner, owner) && String(report.shareId ?? '') === String(shareId ?? '')
    )
    .map((report) => ({
      id: report.id,
      kind: report.kind,
      destination: report.destination,
      paths: report.paths,
      startedAt: report.startedAt,
      interruptedAt: report.interruptedAt,
    }));

/** Told, and no longer waiting to be. */
const forgetInterrupted = (owner, shareId, ids) => {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  const kept = [];
  let forgotten = 0;

  for (const report of interrupted) {
    const mine =
      sameOwner(report.owner, owner) && String(report.shareId ?? '') === String(shareId ?? '');
    if (!mine || (wanted.size > 0 && !wanted.has(String(report.id)))) {
      kept.push(report);
      continue;
    }
    forgotten += 1;
    try {
      fs.rmSync(path.join(journalDirectory(), `${report.id}.json`), { force: true });
    } catch (error) {
      logger.debug({ err: error, taskId: report.id }, 'Could not forget an interrupted operation');
    }
  }

  interrupted = kept;
  return { forgotten };
};

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

const runningFor = (owner) => {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.state === 'running' && sameOwner(task.owner, owner)) count += 1;
  }
  return count;
};

const forget = (task) => {
  if (tasks.get(task.id) === task) tasks.delete(task.id);
};

const settle = (task, state, { result = null, error = null } = {}) => {
  if (task.state !== 'running') return;
  clearTimeout(task.sealTimer);
  task.sealTimer = null;
  task.state = state;
  task.finishedAt = Date.now();
  task.result = result;
  task.error = error;
  releaseRecord(task);

  tell(task, finalEvent(task));
  task.watchers.clear();
  task.resolveSettled?.(publicView(task));
  task.forgetTimer = setTimeout(() => forget(task), RETAIN_SETTLED_MS);
  task.forgetTimer.unref?.();
};

/**
 * Start draining, outside whatever asked for it.
 *
 * A task is not a request: it outlives the one that opened it, and `runDetached`
 * is what keeps it from inheriting that request's path-resolution cache for its
 * whole run. See `utils/requestContext`.
 */
const drain = (task) =>
  runDetached(() =>
    pump(task).catch((error) => {
      logger.error({ err: error, taskId: task.id }, 'An operation stopped unexpectedly');
      settle(task, 'failed', {
        error: { code: 'OPERATION_FAILED', message: 'Operation failed.' },
      });
    })
  );

/**
 * Drain the queue, one unit at a time.
 *
 * Strictly one at a time, and that is a requirement rather than a simplification:
 * a destination name is resolved by checking that it is free and then taking it,
 * which is only safe while nothing else is placing anything in the same folder.
 * Two units of the same task running together would both find `report.txt` free.
 */
const pump = async (task) => {
  if (task.draining) return;
  task.draining = true;

  try {
    for (;;) {
      const unit = task.queue.shift();
      if (!unit) break;

      // Asked only when there is something left to not do. A task whose work
      // finished a moment before the cancellation reached it did finish, and
      // reporting it as cancelled would describe a destination that is full as
      // one that is empty.
      if (task.signal.aborted) {
        task.queue.length = 0;
        settle(task, 'cancelled', {
          error: { code: 'OPERATION_CANCELLED', message: 'Cancelled.' },
        });
        return;
      }

      try {
        await unit.run();
      } catch (error) {
        task.queue.length = 0;
        if (task.signal.aborted || error?.code === 'OPERATION_CANCELLED') {
          settle(task, 'cancelled', {
            error: { code: 'OPERATION_CANCELLED', message: 'Cancelled.' },
          });
        } else {
          const described =
            typeof unit.describeError === 'function'
              ? unit.describeError(error)
              : { code: 'OPERATION_FAILED', message: 'Operation failed.' };
          settle(task, 'failed', { error: described });
        }
        return;
      }
    }

    if (task.sealed) {
      settle(task, 'done', { result: task.collect() });
      return;
    }

    // Out of work but not told it is over: the rest of a large selection is on
    // its way. If it never arrives, the queue closes on what it has.
    if (!task.sealTimer) {
      task.sealTimer = setTimeout(() => {
        task.sealTimer = null;
        if (task.state !== 'running' || task.queue.length > 0) return;
        logger.warn(
          { taskId: task.id, kind: task.kind },
          'An operation was never told it was complete and is closing on what it received'
        );
        task.sealed = true;
        settle(task, 'done', { result: task.collect() });
      }, task.sealWithin);
      task.sealTimer.unref?.();
    }
  } finally {
    task.draining = false;
  }
};

const makeHandle = (task) => ({
  id: task.id,
  signal: task.signal,
  settled: task.settled,
  /** Where the opener keeps the answer it is building. */
  bag: task.bag,
  get state() {
    return task.state;
  },
  /** Bytes the units already finished account for. */
  get settledBytes() {
    return task.settledBytes;
  },

  /**
   * What this task is now also carrying: more items, more bytes, more names.
   * `bytesKnown` false anywhere makes the whole total unknown — a bar drawn
   * against a total that is missing a folder is worse than no bar at all.
   */
  grow: ({ totalItems = 0, totalBytes = 0, bytesKnown = true, names = [] } = {}) => {
    if (task.state !== 'running') return;
    task.totalItems += totalItems;
    task.totalBytes += totalBytes;
    if (!bytesKnown) task.bytesKnown = false;
    for (const name of names) {
      if (task.itemNames.length < MAX_RECORDED_PATHS) task.itemNames.push(name);
    }
    updateRecord(task);
    // Whoever is watching is already past the `start` event, so the totals they
    // were given are now short of what the task is carrying.
    tell(task, { type: 'progress', ...progressNumbers(task) });
  },

  /**
   * Where the unit currently running has got to. Its bytes and its entries are
   * its own, counted from zero: what the task shows is them on top of the units
   * already done, so a caller never has to know what came before it.
   */
  report: ({ unitBytes, unitItems, currentName, percent } = {}) => {
    if (task.state !== 'running') return;
    if (Number.isFinite(unitBytes)) task.copiedBytes = task.settledBytes + unitBytes;
    // What a deletion moves is entries rather than bytes, and it says so while
    // the unit runs; the same rule as the bytes, on the other count.
    if (Number.isFinite(unitItems)) task.completedItems = task.settledItems + unitItems;
    if (typeof currentName === 'string') task.currentName = currentName;
    if (percent != null) task.nativePercent = Number(percent);
    tell(task, { type: 'progress', ...progressNumbers(task) });
  },

  /**
   * What the operation turned out to be about, once the work knows.
   *
   * An archive takes the first name nothing holds — `sample 2` where `sample`
   * is taken — and that is decided while it runs, so the name on screen is
   * corrected rather than left as the one that was asked for.
   */
  rename: (label) => {
    if (task.state !== 'running' || typeof label !== 'string' || !label) return;
    task.label = label;
    tell(task, { type: 'progress', name: label, ...progressNumbers(task) });
  },

  /** One unit finished: its bytes and items are now behind the task. */
  advance: ({ items = 0, bytes = 0 } = {}) => {
    task.settledItems += items;
    task.completedItems = Math.max(task.completedItems, task.settledItems);
    task.settledBytes += bytes;
    task.copiedBytes = Math.max(task.copiedBytes, task.settledBytes);
    task.nativePercent = null;
  },

  /**
   * Add work. `run` does it; `describeError` turns a failure into what the
   * caller is told, so nothing a server-side message holds reaches a client
   * unsanitized.
   */
  enqueue: (run, describeError) => {
    if (task.state !== 'running') return false;
    clearTimeout(task.sealTimer);
    task.sealTimer = null;
    task.queue.push({ run, describeError });
    drain(task);
    return true;
  },

  /** No more work is coming. The task ends when the queue runs dry. */
  seal: () => {
    task.sealed = true;
    drain(task);
  },
});

/**
 * Open a task and get the handle the work is driven through.
 *
 * @param {object} options
 * @param {string} options.kind           'copy', 'move', … — what the UI says
 * @param {object} options.owner          from `ownerOf(req)`; required
 * @param {string|null} options.shareId   the share it belongs to, or null
 * @param {string} options.destination    where it is going, as a logical path
 * @param {() => object} options.collect  the answer, once every unit is done
 */
const open = ({
  kind,
  owner,
  shareId = null,
  destination = '',
  label = '',
  bag = {},
  collect = () => ({}),
  sealWithin = SEAL_WITHIN_MS,
}) => {
  if (!ownerKey(owner)) throw new Error('A task needs an owner.');
  if (runningFor(owner) >= MAX_RUNNING_PER_OWNER) {
    throw new RateLimitError('Too many operations are already running. Wait for one to finish.');
  }

  const controller = new AbortController();
  const task = {
    id: generateId(),
    kind,
    owner,
    shareId: shareId ?? null,
    destination,
    label,
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    itemNames: [],
    totalItems: 0,
    completedItems: 0,
    totalBytes: 0,
    copiedBytes: 0,
    settledBytes: 0,
    settledItems: 0,
    bytesKnown: true,
    nativePercent: null,
    currentName: '',
    result: null,
    error: null,
    queue: [],
    sealed: false,
    sealWithin,
    sealTimer: null,
    forgetTimer: null,
    draining: false,
    watchers: new Set(),
    controller,
    signal: controller.signal,
    bag,
    collect,
  };
  task.settled = new Promise((resolve) => {
    task.resolveSettled = resolve;
  });

  tasks.set(task.id, task);
  record(task);

  return makeHandle(task);
};

/**
 * Add work to a task already open, for the next part of one large selection.
 * Returns the handle, or null when there is no such task *for this caller*:
 * an unknown id and somebody else's id answer the same, so the register never
 * says whether a task exists.
 */
const reopen = (id, owner, { shareId = null, kind = null, destination = null } = {}) => {
  const task = tasks.get(String(id || ''));
  if (!visibleTo(task, owner, shareId)) return null;
  if (task.state !== 'running') return null;
  if (kind && task.kind !== kind) return null;
  if (destination != null && task.destination !== destination) return null;
  return makeHandle(task);
};

/** Watch a task: the caller is caught up first, then told what happens next. */
const watch = (id, owner, { shareId = null } = {}, listener) => {
  const task = tasks.get(String(id || ''));
  if (!visibleTo(task, owner, shareId)) return null;
  if (task.watchers.size >= MAX_WATCHERS_PER_TASK) {
    throw new RateLimitError('This operation is being watched from too many places.');
  }

  listener(startEvent(task));
  if (task.state !== 'running') {
    listener(finalEvent(task));
    return () => {};
  }

  task.watchers.add(listener);
  return () => task.watchers.delete(listener);
};

const find = (id, owner, { shareId = null } = {}) => {
  const task = tasks.get(String(id || ''));
  return visibleTo(task, owner, shareId) ? task : null;
};

const listFor = (owner, { shareId = null } = {}) =>
  [...tasks.values()]
    .filter((task) => visibleTo(task, owner, shareId))
    .sort((left, right) => left.startedAt - right.startedAt)
    .map(publicView);

/** Stop a task. Returns false when the caller has no such task to stop. */
const cancel = (id, owner, { shareId = null } = {}) => {
  const task = find(id, owner, { shareId });
  if (!task) return false;
  if (task.state !== 'running') return true;
  task.controller.abort();
  // A unit that does not watch the signal would otherwise leave the task
  // running until it returns; the pump settles it as soon as it comes back.
  drain(task);
  return true;
};

/** For tests: forget everything, stopping what is running. */
const reset = () => {
  for (const task of tasks.values()) {
    clearTimeout(task.sealTimer);
    clearTimeout(task.forgetTimer);
    task.controller.abort();
    task.watchers.clear();
    releaseRecord(task);
  }
  tasks.clear();
  interrupted = [];
};

module.exports = {
  ownerOf,
  ownerKey,
  open,
  reopen,
  watch,
  find,
  listFor,
  cancel,
  publicView,
  reportInterrupted,
  interruptedFor,
  forgetInterrupted,
  journalDirectory,
  reset,
  RUN_ID,
  SEAL_WITHIN_MS,
  RETAIN_SETTLED_MS,
  MAX_RUNNING_PER_OWNER,
  MAX_WATCHERS_PER_TASK,
};
