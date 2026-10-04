import { buildUrl, normalizePath, requestJson } from './http';
import { shareScoped } from './shareScope';

/**
 * A file's history: its earlier versions, and what can be done with them. A
 * version is always reached through the file it belongs to, named by its path;
 * the server decides what this person may see and do.
 */

const pathQuery = (path) => `path=${encodeURIComponent(normalizePath(path))}`;

/**
 * A version is always reached through the file it belongs to, so the address
 * follows that file: inside a share it is the share's own, like everything else a
 * visitor asks for. See `api/shareScope.js`.
 */
const versionEndpoint = (path, id, suffix = '') =>
  `${shareScoped('/api/versions', normalizePath(path || ''))}/${encodeURIComponent(id)}${suffix}`;

const send = (endpoint, method, body) =>
  requestJson(endpoint, { method, body: JSON.stringify(body) });

/** The versions of a file, newest first, what the file is now, and what may be done. */
async function getVersions(path) {
  return requestJson(
    `${shareScoped('/api/versions', normalizePath(path || ''))}?${pathQuery(path)}`,
    {
      method: 'GET',
    }
  );
}

/** Where a version downloads from: a plain link, so the browser saves it as it does any file. */
function getVersionDownloadUrl(path, id) {
  return buildUrl(`${versionEndpoint(path, id, '/content')}?${pathQuery(path)}`);
}

/** The text of a version, to read and never to change: `{ name, content, … }`. */
async function getVersionText(path, id) {
  return requestJson(`${versionEndpoint(path, id, '/text')}?${pathQuery(path)}`, { method: 'GET' });
}

/** Put the file back as the version had it; what it holds now becomes a version. */
async function restoreVersion(path, id) {
  return send(versionEndpoint(path, id, '/restore'), 'POST', { path: normalizePath(path) });
}

/** Take a version out as a new file in `destination`. */
async function copyVersionTo(path, id, destination) {
  return send(versionEndpoint(path, id, '/copy'), 'POST', {
    path: normalizePath(path),
    destination: normalizePath(destination),
  });
}

/** Put a version's content over another existing file. */
async function replaceWithVersion(path, id, target) {
  return send(versionEndpoint(path, id, '/replace'), 'POST', {
    path: normalizePath(path),
    target: normalizePath(target),
  });
}

/** Name a version, or pin it: `{ label?, pinned? }`. */
async function updateVersion(path, id, changes) {
  return send(versionEndpoint(path, id), 'PATCH', { path: normalizePath(path), ...changes });
}

/** Delete versions for good: `{ ids }`, or `{ all: true }`. */
async function deleteVersions(path, { ids, all = false } = {}) {
  return send(shareScoped('/api/versions/delete', normalizePath(path || '')), 'POST', {
    path: normalizePath(path),
    ...(all ? { all: true } : { ids }),
  });
}

/**
 * The administrator's side: every file that has a history, wherever it is.
 *
 * Addressed by the history's own id rather than by a path, because the ones
 * worth finding include files that no longer exist — a history whose file was
 * deleted outside the application has no path left to ask about.
 */

/** A page of the files that have versions: `{ files, total, totalBytes, zones, … }`. */
async function getVersionedFiles({ zone, state, q, sort, limit, offset } = {}) {
  const query = new URLSearchParams();
  if (zone) query.set('zone', zone);
  if (state) query.set('state', state);
  if (q) query.set('q', q);
  if (sort) query.set('sort', sort);
  if (Number.isFinite(limit)) query.set('limit', String(limit));
  if (Number.isFinite(offset) && offset > 0) query.set('offset', String(offset));
  const suffix = query.toString();
  return requestJson(`/api/versions/admin/files${suffix ? `?${suffix}` : ''}`, { method: 'GET' });
}

/** One history and its versions, by id. */
async function getVersionedFile(id) {
  return requestJson(`/api/versions/admin/files/${encodeURIComponent(id)}`, { method: 'GET' });
}

/** Delete versions of one history: `{ ids }`, or `{ all: true }`. */
async function deleteVersionsOfFile(id, { ids, all = false } = {}) {
  return send(`/api/versions/admin/files/${encodeURIComponent(id)}/delete`, 'POST', {
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
  getVersionedFiles,
  getVersionedFile,
  deleteVersionsOfFile,
};
