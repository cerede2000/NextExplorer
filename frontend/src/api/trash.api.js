import { requestJson, requestStream } from './http';

/**
 * The trash: what the signed-in person can see in it, and what they can do
 * with it. The server decides visibility and who may restore where; these only
 * carry the request.
 */

const post = (endpoint, body = {}) =>
  requestJson(endpoint, { method: 'POST', body: JSON.stringify(body) });

async function getTrash() {
  return requestJson('/api/trash', { method: 'GET' });
}

/** `shares`: what becomes of the share links the items kept — 'restore' or 'drop'. */
async function restoreTrashItems(ids, { shares } = {}) {
  return post('/api/trash/restore', shares ? { ids, shares } : { ids });
}

/** What a deleted folder holds, at `entryPath` inside it ('' for its top). */
async function getTrashEntries(id, entryPath = '') {
  const query = entryPath ? `?path=${encodeURIComponent(entryPath)}` : '';
  return requestJson(`/api/trash/items/${encodeURIComponent(id)}/entries${query}`, {
    method: 'GET',
  });
}

/** Put back entries from inside a deleted folder; the rest of it stays in the trash. */
async function restoreTrashEntries(id, paths, { shares } = {}) {
  return post(
    `/api/trash/items/${encodeURIComponent(id)}/restore`,
    shares ? { paths, shares } : { paths }
  );
}

/**
 * Put items in a chosen folder. Streamed like a transfer, since across disks it
 * is a copy: `onEvent` receives start and progress, and the result is the final
 * `{ destination, items }`.
 */
async function restoreTrashItemsTo(ids, destination, { onEvent, signal, shares } = {}) {
  return requestStream('/api/trash/restore-to', {
    method: 'POST',
    body: JSON.stringify(shares ? { ids, destination, shares } : { ids, destination }),
    onEvent,
    signal,
  });
}

/** Put entries of a deleted folder in a chosen folder, streamed the same way. */
async function restoreTrashEntriesTo(id, paths, destination, { onEvent, signal, shares } = {}) {
  return requestStream(`/api/trash/items/${encodeURIComponent(id)}/restore-to`, {
    method: 'POST',
    body: JSON.stringify(shares ? { paths, destination, shares } : { paths, destination }),
    onEvent,
    signal,
  });
}

async function deleteTrashItems(ids, { forgetUnavailable = false } = {}) {
  return post('/api/trash/delete', forgetUnavailable ? { ids, forgetUnavailable: true } : { ids });
}

async function emptyTrash() {
  return post('/api/trash/empty');
}

async function getTrashZones() {
  return requestJson('/api/trash/zones', { method: 'GET' });
}

async function verifyTrash() {
  return post('/api/trash/verify');
}

async function runTrashMaintenance() {
  return post('/api/trash/maintenance');
}

export {
  getTrash,
  getTrashEntries,
  restoreTrashItems,
  restoreTrashEntries,
  restoreTrashItemsTo,
  restoreTrashEntriesTo,
  deleteTrashItems,
  emptyTrash,
  getTrashZones,
  verifyTrash,
  runTrashMaintenance,
};
