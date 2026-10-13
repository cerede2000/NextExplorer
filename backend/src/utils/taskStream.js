const { startNdjsonStream } = require('./ndjsonStream');
const operationTasks = require('../services/operationTasks');
const { NotFoundError, UnauthorizedError } = require('../errors/AppError');

/**
 * Hand one response the events of one task, from wherever it has got to.
 *
 * The same stream a transfer has always answered with — `start`, then
 * `progress`, then `done` or `error` — except that it is now a window rather
 * than the operation itself: closing it detaches a watcher and nothing else.
 *
 * The register is asked *before* the status is committed, because a refusal
 * (somebody else's task, an unknown one, too many watchers) has to be an
 * ordinary HTTP error, and once an NDJSON stream has started there is no status
 * left to send. The first events arrive while the register is being asked —
 * `watch` catches a new watcher up synchronously — so they are held and written
 * as soon as the stream is open.
 */
const streamTask = (res, taskId, owner, shareId = null) => {
  const held = [];
  let deliver = (event) => held.push(event);
  let detach = null;

  const stop = () => {
    const release = detach;
    detach = null;
    release?.();
  };

  const release = operationTasks.watch(taskId, owner, { shareId }, (event) => deliver(event));
  if (!release) throw new NotFoundError('No such operation.');
  detach = release;

  const writeEvent = startNdjsonStream(res, { onClose: stop });
  deliver = (event) => {
    writeEvent(event);
    if (event.type === 'done' || event.type === 'error') {
      stop();
      if (!res.writableEnded) res.end();
    }
  };

  for (const event of held) deliver(event);
};

/**
 * Register one piece of work and hand this response the window onto it.
 *
 * For the operations that are described in a single request — an archive
 * unpacked or packed, entries taken out of one, something brought back out of
 * the trash. Each of them used to run inside its request and be aborted by its
 * own socket closing, so a reader who closed the tab half-way through unpacking
 * twenty gigabytes lost all of it and was told nothing.
 *
 * Everything that can be refused must already have been: this commits a 200 and
 * from then on a failure can only be an error *event*. `work` does the work and
 * is handed the task, so it can report as it goes and watch `signal`; whatever
 * it cleans up on the way out it still cleans up, because the register only
 * reports what it throws. `describeError` turns that into what the caller is
 * told, and `collect` into the `done` event.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} options
 * @param {string} options.kind         'extract', 'compress', 'restore', …
 * @param {string} [options.destination] where it is going, as a logical path
 * @param {string} [options.label]      what it is about, where that is a name
 * @param {object} [options.bag]        where `work` keeps the answer it builds
 * @param {() => object} options.collect      the `done` event's own fields
 * @param {(handle: object) => Promise<void>} options.work
 * @param {(error: Error) => object} options.describeError
 */
const streamAsTask = (
  req,
  res,
  { kind, destination = '', label = '', bag = {}, collect, work, describeError }
) => {
  const owner = operationTasks.ownerOf(req);
  if (!owner) throw new UnauthorizedError('Authentication required.');
  const shareId = req.shareScope?.shareId ?? null;

  const handle = operationTasks.open({ kind, owner, shareId, destination, label, bag, collect });
  handle.enqueue(() => work(handle), describeError);
  handle.seal();

  streamTask(res, handle.id, owner, shareId);
  return handle;
};

module.exports = { streamTask, streamAsTask };
