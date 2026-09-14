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

async function restoreTrashItems(ids) {
  return post('/api/trash/restore', { ids });
}

/** What a deleted folder holds, at `entryPath` inside it ('' for its top). */
async function getTrashEntries(id, entryPath = '') {
  const query = entryPath ? `?path=${encodeURIComponent(entryPath)}` : '';
  return requestJson(`/api/trash/items/${encodeURIComponent(id)}/entries${query}`, {
    method: 'GET',
  });
}

/**
 * The text of a file in the trash — the item itself, or a file at `entryPath`
 * inside a deleted folder — to read, never to change: `{ name, content, … }`.
 */
async function getTrashFileText(id, entryPath = '') {
  const query = entryPath ? `?path=${encodeURIComponent(entryPath)}` : '';
  return requestJson(`/api/trash/items/${encodeURIComponent(id)}/text${query}`, {
    method: 'GET',
  });
}

/** Put back entries from inside a deleted folder; the rest of it stays in the trash. */
async function restoreTrashEntries(id, paths) {
  return post(`/api/trash/items/${encodeURIComponent(id)}/restore`, { paths });
}

/**
 * Put items in a chosen folder. Streamed like a transfer, since across disks it
 * is a copy: `onEvent` receives start and progress, and the result is the final
 * `{ destination, items }`.
 */
async function restoreTrashItemsTo(ids, destination, { onEvent, signal } = {}) {
  return requestStream('/api/trash/restore-to', {
    method: 'POST',
    body: JSON.stringify({ ids, destination }),
    onEvent,
    signal,
  });
}

/** Put entries of a deleted folder in a chosen folder, streamed the same way. */
async function restoreTrashEntriesTo(id, paths, destination, { onEvent, signal } = {}) {
  return requestStream(`/api/trash/items/${encodeURIComponent(id)}/restore-to`, {
    method: 'POST',
    body: JSON.stringify({ paths, destination }),
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
  getTrashFileText,
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
