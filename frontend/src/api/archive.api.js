import { buildUrl, normalizePath, requestJson } from './http';

/**
 * Looking inside an archive without unpacking it.
 *
 * The archive is named by its path, like any other file, and where to look
 * inside it is a separate parameter — never one path with the archive in the
 * middle of it. The server decides what this person may open and what a name
 * inside the archive is allowed to mean.
 */

const pathQuery = (path) => `path=${encodeURIComponent(normalizePath(path))}`;

/** One level of an archive: `{ path, name, inside, entries, total, outside }`. */
async function browseArchive(path, inside = '') {
  const position = inside ? `&inside=${encodeURIComponent(inside)}` : '';
  return requestJson(`/api/archive/list?${pathQuery(path)}${position}`, { method: 'GET' });
}

/** Where one entry downloads from: a plain link, so the browser saves it as it does any file. */
function archiveEntryUrl(path, entry) {
  return buildUrl(`/api/archive/entry?${pathQuery(path)}&entry=${encodeURIComponent(entry)}`);
}

export { browseArchive, archiveEntryUrl };
