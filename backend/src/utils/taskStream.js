const { startNdjsonStream } = require('./ndjsonStream');
const operationTasks = require('../services/operationTasks');
const { NotFoundError } = require('../errors/AppError');

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

module.exports = { streamTask };
