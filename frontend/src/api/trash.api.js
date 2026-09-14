import { requestJson } from './http';

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

/** Put back entries from inside a deleted folder; the rest of it stays in the trash. */
async function restoreTrashEntries(id, paths) {
  return post(`/api/trash/items/${encodeURIComponent(id)}/restore`, { paths });
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
  deleteTrashItems,
  emptyTrash,
  getTrashZones,
  verifyTrash,
  runTrashMaintenance,
};
