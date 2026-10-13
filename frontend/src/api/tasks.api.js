import { requestJson, requestStream } from './http';
import { shareScopedForPage } from './shareScope';

/**
 * The operations of whoever is reading this page, which no longer belong to a tab.
 *
 * A copy or a move runs in the server and a tab is a window onto it, so these
 * are how a window is reopened: what is running, how to follow one of them, and
 * how to stop one. The server answers for the caller's own operations only.
 *
 * Addressed by the page rather than by a path, because none of these is about a
 * path — and a visitor behind an authentication proxy reaches the share's prefix
 * and nothing else, so inside a share they have to be asked there (see
 * `api/shareScope`).
 */
/**
 * One operation's address, built from the endpoint and the id.
 *
 * The endpoint is spelled out as a plain string on purpose: the rule that puts a
 * request under a share's prefix is applied here and enumerated by reading these
 * call sites, and an address assembled out of pieces cannot be compared with
 * what the server mounts (see `tests/routes/share-prefix-answers-what-is-asked`).
 */
const taskAddress = (taskId, action) =>
  `${shareScopedForPage('/api/tasks')}/${encodeURIComponent(taskId)}/${action}`;

export const fetchOperationTasks = async () => {
  const payload = await requestJson(shareScopedForPage('/api/tasks'));
  return {
    items: Array.isArray(payload?.items) ? payload.items : [],
    interrupted: Array.isArray(payload?.interrupted) ? payload.interrupted : [],
  };
};

/**
 * Follow one, from wherever it has got to: the stream opens with a `start` event
 * built from the operation's current state, then reports as it goes.
 *
 * A cancellation arrives as an error event, which is not something to put a red
 * notification on the screen for: it is what the reader just asked for.
 */
export const watchOperationTask = (taskId, { onEvent, signal } = {}) =>
  requestStream(taskAddress(taskId, 'stream'), {
    method: 'GET',
    onEvent,
    signal,
    suppressErrorCodes: ['OPERATION_CANCELLED'],
  });

export const cancelOperationTask = (taskId) =>
  requestJson(taskAddress(taskId, 'cancel'), {
    method: 'POST',
  });

/**
 * What a restart took, acknowledged.
 *
 * Nothing is resumed across a stop — half a copy is a state on disk, and picking
 * it up would mean deciding about what is already there — so what the server has
 * is a record of what was in flight, kept until the person who started it has
 * been told. Without `ids`, all of theirs.
 */
export const forgetInterruptedTasks = (ids = []) =>
  requestJson(shareScopedForPage('/api/tasks/interrupted/ack'), {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
