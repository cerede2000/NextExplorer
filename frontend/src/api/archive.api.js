import { buildUrl, normalizePath, requestJson, requestRaw, requestStream } from './http';

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

/**
 * The bytes of one entry, to look at rather than to keep.
 *
 * The same address the download link points at, asked for as data. The server
 * answers it as an attachment and tells the browser not to guess at its type,
 * which is what keeps somebody else's HTML from ever running as a page on this
 * origin — so what is read here is drawn by the panel itself, never handed to
 * the browser as something to open.
 */
async function readArchiveEntry(path, entry, options = {}) {
  return requestRaw(`/api/archive/entry?${pathQuery(path)}&entry=${encodeURIComponent(entry)}`, {
    method: 'GET',
    signal: options.signal,
  });
}

/**
 * Take entries out of an archive, into the folder the archive is in.
 *
 * A folder stands for everything under it. The endpoint answers with the same
 * stream of events the other archive operations write — start, progress, done
 * or error — so `onEvent` sees each one as it arrives.
 */
async function extractFromArchive(path, entries, options = {}) {
  return requestStream('/api/archive/extract', {
    method: 'POST',
    body: JSON.stringify({ path: normalizePath(path), entries }),
    onEvent: options.onEvent,
    signal: options.signal,
  });
}

export { browseArchive, archiveEntryUrl, readArchiveEntry, extractFromArchive };
