import { buildUrl, normalizePath, requestJson } from './http';

/**
 * A file's history: its earlier versions, and what can be done with them. A
 * version is always reached through the file it belongs to, named by its path;
 * the server decides what this person may see and do.
 */

const pathQuery = (path) => `path=${encodeURIComponent(normalizePath(path))}`;
const versionEndpoint = (id, suffix = '') => `/api/versions/${encodeURIComponent(id)}${suffix}`;

const send = (endpoint, method, body) =>
  requestJson(endpoint, { method, body: JSON.stringify(body) });

/** The versions of a file, newest first, what the file is now, and what may be done. */
async function getVersions(path) {
  return requestJson(`/api/versions?${pathQuery(path)}`, { method: 'GET' });
}

/** Where a version downloads from: a plain link, so the browser saves it as it does any file. */
function getVersionDownloadUrl(path, id) {
  return buildUrl(`${versionEndpoint(id, '/content')}?${pathQuery(path)}`);
}

/** The text of a version, to read and never to change: `{ name, content, … }`. */
async function getVersionText(path, id) {
  return requestJson(`${versionEndpoint(id, '/text')}?${pathQuery(path)}`, { method: 'GET' });
}

/** Put the file back as the version had it; what it holds now becomes a version. */
async function restoreVersion(path, id) {
  return send(versionEndpoint(id, '/restore'), 'POST', { path: normalizePath(path) });
}

/** Take a version out as a new file in `destination`. */
async function copyVersionTo(path, id, destination) {
  return send(versionEndpoint(id, '/copy'), 'POST', {
    path: normalizePath(path),
    destination: normalizePath(destination),
  });
}

/** Put a version's content over another existing file. */
async function replaceWithVersion(path, id, target) {
  return send(versionEndpoint(id, '/replace'), 'POST', {
    path: normalizePath(path),
    target: normalizePath(target),
  });
}

/** Name a version, or pin it: `{ label?, pinned? }`. */
async function updateVersion(path, id, changes) {
  return send(versionEndpoint(id), 'PATCH', { path: normalizePath(path), ...changes });
}

/** Delete versions for good: `{ ids }`, or `{ all: true }`. */
async function deleteVersions(path, { ids, all = false } = {}) {
  return send('/api/versions/delete', 'POST', {
    path: normalizePath(path),
    ...(all ? { all: true } : { ids }),
  });
}

export {
  getVersions,
  getVersionDownloadUrl,
  getVersionText,
  restoreVersion,
  copyVersionTo,
  replaceWithVersion,
  updateVersion,
  deleteVersions,
};
