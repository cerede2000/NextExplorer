import { shareScoped, shareScopedForAny, shareScopedForPage, shareTokenOfPath } from './shareScope';
import {
  requestJson,
  requestRaw,
  requestStream,
  normalizePath,
  encodePath,
  buildUrl,
} from './http';
import { browseShare } from './shares.api';

const DELETE_BATCH_SIZE = 100;

/**
 * Items per streamed deletion request.
 *
 * The streaming endpoint used to receive the whole selection at once, and a
 * few thousand paths is more JSON than a server accepts by default: the
 * request came back as "request entity too large" before anything read it.
 * The batches are large enough that the progress bar still moves smoothly,
 * and small enough that no single request depends on a generous body limit.
 */
const DELETE_STREAM_BATCH_SIZE = 500;

/**
 * Paths per request when a copy or a move is described.
 *
 * Same reason as the deletion batch: the whole selection in one body is refused
 * as too large. Unlike deletion, these are not separate operations — every batch
 * names the same one — so this is only how much of a selection fits in a body.
 */
const TRANSFER_BATCH_SIZE = 500;

/**
 * Fold the per-batch results back into the single response the caller expects:
 * the transferred entries, and the destination the server settled on (it may
 * rename to avoid a collision).
 */
/**
 * Fold impact responses into the single summary the dialog reads. Shares are
 * deduplicated: a folder and a file inside it can report the same one.
 */
const summarizeDeleteImpact = (responses) => {
  const sharesById = new Map();
  let trash = null;
  for (const response of responses) {
    for (const share of Array.isArray(response?.shares) ? response.shares : []) {
      if (share?.id) sharesById.set(share.id, share);
    }
    // Every batch answers from the same settings; the items are what add up.
    if (response?.trash) {
      trash = {
        enabled: Boolean(response.trash.enabled),
        retentionDays: response.trash.retentionDays ?? null,
        items: [
          ...(trash?.items || []),
          ...(Array.isArray(response.trash.items) ? response.trash.items : []),
        ],
      };
    }
  }
  const shares = Array.from(sharesById.values());
  return { shareCount: shares.length, shares, trash };
};

/** Only sent when asked for, so a request without it means what it always meant. */
const permanentFlag = (options = {}) => (options.permanent === true ? { permanent: true } : {});

/**
 * One answer for a transfer the client sent in batches.
 *
 * `unreadable` is added up rather than taken from the last batch: a selection
 * split across requests is one gesture to the person who made it, and a count
 * that only described the final batch would be short by everything before it.
 */
const mergeTransferResults = (results) => {
  if (!Array.isArray(results)) return results;
  const merged = { success: true, items: [], unreadable: 0 };
  for (const result of results) {
    if (Array.isArray(result?.items)) merged.items.push(...result.items);
    if (result?.destination != null) merged.destination = result.destination;
    merged.unreadable += Number(result?.unreadable) || 0;
  }
  return merged;
};

/**
 * A folder's listing, from whichever door the folder is behind.
 *
 * A share's listing has its own endpoint, which is what the browser's folder
 * pane has always used. Everything else that walks folders — the dialog that
 * asks where to copy something, the file picker the editor opens — asked here,
 * and `/api/browse` is
 * not a visitor's address: inside a share they were told the folder could not be
 * listed. So the share's door is taken here too, by the same rule as the rest:
 * the path says which share it belongs to.
 */
async function browse(path = '', options = {}) {
  const normalizedPath = normalizePath(path);
  const token = shareTokenOfPath(normalizedPath);
  if (token) {
    return browseShare(token, normalizedPath.slice(`share/${token}`.length), options);
  }
  const encodedPath = encodePath(normalizedPath);
  const endpoint = encodedPath ? `/api/browse/${encodedPath}` : '/api/browse/';
  return requestJson(endpoint, {
    method: 'GET',
    signal: options.signal,
    // A directory listing contains short-lived state (including OnlyOffice
    // activity), so a browser or intermediary cache must never reuse it.
    cache: 'no-store',
  });
}

async function getVolumes() {
  return requestJson('/api/volumes', { method: 'GET' });
}

async function getUsage(path = '') {
  const normalizedPath = normalizePath(path);
  const encodedPath = encodePath(normalizedPath);
  return requestJson(`${shareScoped('/api/usage', normalizedPath)}/${encodedPath}`, {
    method: 'GET',
  });
}

async function getFolderSizesBatch(paths = [], options = {}) {
  const normalizedPaths = (Array.isArray(paths) ? paths : [])
    .map((p) => normalizePath(p))
    .filter(Boolean);
  return requestJson(shareScoped('/api/folder-size/batch', normalizedPaths[0] || ''), {
    ...options,
    method: 'POST',
    body: JSON.stringify({ paths: normalizedPaths }),
  });
}

async function refreshFolderSize(relativePath, options = {}) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    throw new Error('A folder path is required to refresh its size.');
  }
  const encodedPath = encodePath(normalizedPath);
  return requestJson(`${shareScoped('/api/folder-size/refresh', normalizedPath)}/${encodedPath}`, {
    ...options,
    method: 'POST',
  });
}

/**
 * One operation, however many requests it takes to describe it.
 *
 * The work happens in the server now and the response is a window onto it, so a
 * copy, a move or a deletion is no longer bound to the tab that asked for it.
 * Two things follow from that, and they are what this function is.
 *
 * The whole selection is one operation. The paths still go out in batches —
 * several thousand of them in one body is refused as too large — but they all
 * name the same operation: the first request opens it and says that more is
 * coming, the rest are added to it and answered at once, and only the first
 * carries the stream. A reader who closes the tab half a second in no longer
 * loses the parts that had not been sent, because they are already sent. And
 * because there is one operation, there is one set of figures and one answer:
 * none of the adding up the client used to do across its own batches.
 *
 * And it says which operation it is. `onTask` is called with the id as soon as
 * the server gives it, which is what lets the caller stop it — an operation is
 * stopped by asking the server to, not by hanging up.
 *
 * `address` is already under the share's prefix when the work is inside one:
 * each caller below spells its own endpoint out, because that rule is enforced
 * where the address is built and enumerated by reading those call sites — an
 * address assembled out of pieces cannot be compared with what the server
 * mounts (see `tests/routes/share-prefix-answers-what-is-asked`).
 *
 * @param {string} address  the endpoint, already scoped
 * @param {Array} items  the whole selection
 * @param {number} batchSize  how many paths one body may carry
 * @param {(batch: Array, extras: object) => object} bodyFor  one request's body
 * @param {object} [options]  onEvent, onTask, signal, suppressErrorCodes
 */
async function inOneOperation(address, items, batchSize, bodyFor, options = {}) {
  const all = Array.isArray(items) ? items : [];
  const batches = [];
  for (let index = 0; index < all.length; index += batchSize) {
    batches.push(all.slice(index, index + batchSize));
  }
  // Nothing to do is for the server to refuse, as it always has.
  if (batches.length === 0) batches.push([]);

  let announce = () => {};
  const operation = new Promise((resolve) => {
    announce = resolve;
  });

  const theRest = (async () => {
    if (batches.length < 2) return;
    const taskId = await operation;
    // No id means the first request never got as far as opening one; there is
    // nothing for the rest of the selection to be added to.
    if (!taskId) return;
    for (let index = 1; index < batches.length; index += 1) {
      await requestJson(address, {
        method: 'POST',
        body: JSON.stringify(
          bodyFor(batches[index], {
            taskId,
            ...(index < batches.length - 1 ? { continues: true } : {}),
          })
        ),
      });
    }
  })();

  const watched = requestStream(address, {
    method: 'POST',
    body: JSON.stringify(bodyFor(batches[0], batches.length > 1 ? { continues: true } : {})),
    onEvent: (event) => {
      if (event?.type === 'start') {
        announce(event.taskId || null);
        if (typeof options.onTask === 'function') options.onTask(event.taskId || null);
      }
      if (typeof options.onEvent === 'function') options.onEvent(event);
    },
    signal: options.signal,
    suppressErrorCodes: notARefusal(options.suppressErrorCodes),
  });
  // However that request ends, nothing more is waiting on an id from it.
  watched.then(
    () => announce(null),
    () => announce(null)
  );

  // Both are awaited before either is thrown: a refused part must not leave the
  // stream's own failure unhandled.
  const settled = await Promise.allSettled([watched, theRest]);
  const refused = settled.find((outcome) => outcome.status === 'rejected');
  if (refused) throw refused.reason;
  return settled[0].value;
}

/**
 * A cancellation is not something to put a red notice on the screen for.
 *
 * It arrives as the operation's own error event now, where it used to be a
 * dropped connection nobody reported — so without this, a reader who pressed
 * cancel is told their operation failed.
 */
const notARefusal = (codes = []) => ['OPERATION_CANCELLED', ...codes];

/**
 * Hand the caller the operation's id as soon as the server names it.
 *
 * For the operations described in a single request — an archive unpacked or
 * packed, something brought back out of the trash. The id arrives in the `start`
 * event, and without it the caller has nothing to ask the server to stop.
 */
const watchingTheOperation =
  ({ onEvent, onTask } = {}) =>
  (event) => {
    if (event?.type === 'start' && typeof onTask === 'function') onTask(event.taskId || null);
    if (typeof onEvent === 'function') onEvent(event);
  };

/** One part of a copy or a move, as the server reads it. */
const transferPart = (destination) => (batch, extras) => ({
  items: batch,
  destination,
  ...extras,
});

async function copyItems(items, destination, options = {}) {
  const first = (Array.isArray(items) ? items : [])[0];
  const result = await inOneOperation(
    shareScopedForAny('/api/files/copy', destination, first),
    items,
    TRANSFER_BATCH_SIZE,
    transferPart(destination),
    options
  );
  return mergeTransferResults([result]);
}

async function moveItems(items, destination, options = {}) {
  const first = (Array.isArray(items) ? items : [])[0];
  const result = await inOneOperation(
    shareScopedForAny('/api/files/move', destination, first),
    items,
    TRANSFER_BATCH_SIZE,
    transferPart(destination),
    options
  );
  return mergeTransferResults([result]);
}

/**
 * What a file's bytes add up to, as far as anybody knows.
 *
 * Never computes: an answer means the file was read once before and has not
 * changed since, and no answer means nobody has asked for it to be read. Taking
 * them is the other call, because on a large file it is minutes of reading.
 */
async function fetchKnownChecksums(relativePath) {
  const path = normalizePath(relativePath);
  return requestJson(
    `${shareScoped('/api/files/checksums', path)}?path=${encodeURIComponent(path)}`
  );
}

/**
 * Read these files and answer what they add up to.
 *
 * A registered operation: it reports as it reads, it can be stopped, and
 * closing the tab no longer loses twenty minutes of reading. With `compare`,
 * the answer also says whether the files are the same — and says it from the
 * sizes alone when those already decide it.
 */
async function takeChecksums(items, options = {}) {
  const all = Array.isArray(items) ? items : [];
  return requestStream(shareScopedForAny('/api/files/checksums', all[0]), {
    method: 'POST',
    body: JSON.stringify({
      items: all,
      ...(options.compare ? { compare: true } : {}),
    }),
    onEvent: watchingTheOperation(options),
    signal: options.signal,
    suppressErrorCodes: notARefusal(),
  });
}

/**
 * Files this reader started sending and did not finish.
 *
 * An upload cannot carry on by itself the way a copy in the server does: the
 * bytes are in the browser, so when the tab goes away nobody is sending any.
 * What the server keeps is the part that arrived and the position it reached, so
 * giving it the same file again sends only the rest — and this is how a reader
 * learns there is anything to give again. Their own only, and only the ones
 * started under the share they are asking from.
 */
async function fetchUnfinishedUploads() {
  const payload = await requestJson(shareScopedForPage('/api/upload/unfinished'), {
    // Nothing on a page depends on this: a reader who cannot be told has
    // nothing to do about it either.
    suppressErrorHandler: true,
  });
  return Array.isArray(payload?.items) ? payload.items : [];
}

/**
 * Folders this user has recently moved or copied things into, most recent
 * first. The server only returns the ones still reachable, so the picker can
 * offer them without checking each in turn.
 */
async function fetchRecentDestinations() {
  const payload = await requestJson(shareScopedForPage('/api/files/recent-destinations'));
  return Array.isArray(payload?.items) ? payload.items : [];
}

async function deleteItems(items, options = {}) {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (normalizedItems.length <= DELETE_BATCH_SIZE) {
    return requestJson(shareScopedForAny('/api/files', normalizedItems[0]), {
      method: 'DELETE',
      body: JSON.stringify({ items: normalizedItems, ...permanentFlag(options) }),
    });
  }

  const deletedItems = [];
  for (let index = 0; index < normalizedItems.length; index += DELETE_BATCH_SIZE) {
    const batch = normalizedItems.slice(index, index + DELETE_BATCH_SIZE);
    const response = await requestJson(shareScopedForAny('/api/files', batch[0]), {
      method: 'DELETE',
      body: JSON.stringify({ items: batch, ...permanentFlag(options) }),
    });
    deletedItems.push(...(Array.isArray(response?.items) ? response.items : []));
  }

  return { success: true, items: deletedItems };
}

async function deleteItemsStream(items, options = {}) {
  const first = (Array.isArray(items) ? items : [])[0];
  const result = await inOneOperation(
    shareScopedForAny('/api/files/delete-stream', first),
    items,
    DELETE_STREAM_BATCH_SIZE,
    (batch, extras) => ({ items: batch, ...permanentFlag(options), ...extras }),
    options
  );
  return {
    success: true,
    items: Array.isArray(result?.items) ? result.items : [],
  };
}

async function getDeleteImpact(items) {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (normalizedItems.length <= DELETE_STREAM_BATCH_SIZE) {
    return summarizeDeleteImpact([
      await requestJson(shareScopedForAny('/api/files/delete-impact', normalizedItems[0]), {
        method: 'POST',
        body: JSON.stringify({ items: normalizedItems }),
      }),
    ]);
  }

  // Read-only and independent, so the batches go out together: this runs
  // before the confirmation dialog can even be shown, and a serialized chain
  // of them is latency the user waits through for nothing.
  const batches = [];
  for (let index = 0; index < normalizedItems.length; index += DELETE_STREAM_BATCH_SIZE) {
    batches.push(normalizedItems.slice(index, index + DELETE_STREAM_BATCH_SIZE));
  }

  const responses = await Promise.all(
    batches.map((batch) =>
      requestJson(shareScopedForAny('/api/files/delete-impact', batch[0]), {
        method: 'POST',
        body: JSON.stringify({ items: batch }),
      })
    )
  );

  return summarizeDeleteImpact(responses);
}

async function createFolder(destination, name) {
  const normalizedDestination = normalizePath(destination || '');
  const payload = { path: normalizedDestination };

  if (typeof name === 'string' && name.trim()) {
    payload.name = name;
  }

  return requestJson(shareScoped('/api/files/folder', normalizedDestination), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * The folder a batch lands in, asked for once, before a byte is sent.
 *
 * The batch's own name travels with the question. The server resolves a file
 * that arrives without the path this answer is written onto — every file of a
 * batch a reader stopped, since the resolving ends at once and a request
 * already on its way does not — and without the batch's name it had no way to
 * tell that such a file belonged to a folder it had already reserved, so it
 * reserved another.
 */
async function reserveFolderUploadTarget(destination, sourceRoot, uploadBatchId) {
  const uploadTo = normalizePath(destination || '');
  if (!uploadTo || typeof sourceRoot !== 'string' || !sourceRoot.trim()) {
    throw new Error('A destination and folder name are required to start a folder upload.');
  }

  return requestJson(shareScoped('/api/upload/folder-session', uploadTo), {
    method: 'POST',
    body: JSON.stringify({ uploadTo, sourceRoot, uploadBatchId }),
  });
}

/**
 * Create a blank Word, Excel or PowerPoint document.
 *
 * `format` is the extension the document will carry ('docx', 'xlsx', 'pptx');
 * the server owns it, so a name that lacks it gains it. Separate from
 * createFile because an empty file with an office extension is not a document
 * any editor will open.
 */
async function createOfficeDocument(destination, { format, name, extension } = {}) {
  const normalizedDestination = normalizePath(destination || '');
  const payload = { path: normalizedDestination, format };

  if (typeof name === 'string' && name.trim()) {
    payload.name = name.trim();
  }

  // Sent only when the caller has one to say, because absent and empty are two
  // different requests: absent means "the format's own extension", empty means
  // "no extension at all", which is how a `Dockerfile` is asked for.
  if (typeof extension === 'string') {
    payload.extension = extension.trim();
  }

  return requestJson(shareScoped('/api/files/office-document', normalizedDestination), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function createFile(destination, name) {
  const normalizedDestination = normalizePath(destination || '');
  const payload = { path: normalizedDestination };

  if (typeof name === 'string' && name.trim()) {
    payload.name = name;
  }

  return requestJson(shareScoped('/api/files/file', normalizedDestination), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function renameItem(path, name, newName) {
  const normalizedPath = normalizePath(path || '');
  return requestJson(shareScoped('/api/files/rename', normalizedPath), {
    method: 'POST',
    body: JSON.stringify({
      path: normalizedPath,
      name,
      newName,
    }),
  });
}

/**
 * The text of a file, for the editor and the Markdown preview.
 *
 * A GET, so the browser keeps the answer: the server marks it to be checked
 * every time and answers 304 when the file has not changed, which the browser
 * turns back into the copy it kept. Opening the editor from the preview used
 * to download the whole file a second time — a POST is never kept.
 */
/**
 * Inside a share this is the share's own endpoint, which already exists.
 *
 * Not `/api/editor` under the share's prefix: that address is the share's own
 * editor — `/api/share/<token>/editor/<inner>` — and asking it with a `path`
 * query would reach the share's root instead of the file. The Markdown preview
 * reads a shared file through here, so it had to be told which door to use.
 */
async function fetchFileContent(path) {
  const normalizedPath = normalizePath(path || '');
  const token = shareTokenOfPath(normalizedPath);
  if (token) {
    return fetchSharedFileContent(token, normalizedPath.slice(`share/${token}`.length));
  }
  return requestJson(`/api/editor?path=${encodeURIComponent(path)}`, { method: 'GET' });
}

async function fetchSharedFileContent(shareToken, innerPath = '') {
  const encodedToken = encodeURIComponent(shareToken);
  const normalizedInnerPath = normalizePath(innerPath);
  const encodedInnerPath = encodePath(normalizedInnerPath);
  const endpoint = encodedInnerPath
    ? `/api/share/${encodedToken}/editor/${encodedInnerPath}`
    : `/api/share/${encodedToken}/editor`;

  return requestJson(endpoint, { method: 'GET' });
}

async function saveSharedFileContent(shareToken, innerPath = '', content) {
  const encodedToken = encodeURIComponent(shareToken);
  const normalizedInnerPath = normalizePath(innerPath);
  const encodedInnerPath = encodePath(normalizedInnerPath);
  const endpoint = encodedInnerPath
    ? `/api/share/${encodedToken}/editor/${encodedInnerPath}`
    : `/api/share/${encodedToken}/editor`;

  return requestJson(endpoint, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

async function saveFileContent(path, content) {
  const normalizedPath = normalizePath(path || '');
  const token = shareTokenOfPath(normalizedPath);
  if (token) {
    return saveSharedFileContent(token, normalizedPath.slice(`share/${token}`.length), content);
  }
  return requestJson('/api/editor', {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  });
}

function getRawFileUrl(path) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) {
    throw new Error('A file path is required.');
  }

  const params = new URLSearchParams({ path: normalizedPath });
  return buildUrl(`${shareScoped('/api/raw', normalizedPath)}?${params.toString()}`);
}

async function fetchThumbnail(relativePath, options = {}) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    throw new Error('A file path is required to fetch a thumbnail.');
  }
  const encodedPath = encodePath(normalizedPath);
  const { background = false, ...requestOptions } = options;
  const suffix = background ? '?background=1' : '';
  // Thumbnails are best-effort/background: never surface a global error toast on
  // a missing source. Callers inspect the thrown error's statusCode to decide
  // whether to retry.
  return requestJson(`${shareScoped('/api/thumbnails', normalizedPath)}/${encodedPath}${suffix}`, {
    method: 'GET',
    suppressErrorHandler: true,
    ...requestOptions,
  });
}

async function fetchMetadata(relativePath) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    throw new Error('A file path is required to fetch metadata.');
  }
  const encodedPath = encodePath(normalizedPath);
  return requestJson(`${shareScoped('/api/metadata', normalizedPath)}/${encodedPath}`, {
    method: 'GET',
  });
}

async function downloadItems(paths, basePath = '') {
  const normalizedList = (Array.isArray(paths) ? paths : [paths])
    .map((item) => normalizePath(item))
    .filter(Boolean);

  if (normalizedList.length === 0) {
    throw new Error('At least one path is required for download.');
  }

  const normalizedBase = normalizePath(basePath || '');

  // Use requestRaw as this returns a file blob, not JSON
  return requestRaw(shareScoped('/api/download', normalizedBase || normalizedList[0]), {
    method: 'POST',
    body: JSON.stringify({
      items: normalizedList,
      basePath: normalizedBase,
    }),
  });
}

/**
 * The same selection, described instead of sent (#487).
 *
 * Answers the names and sizes of the loose files, plus the one archive the
 * selected folders become, and a token naming those parts. The counting and the
 * log entry happen here, once, so that fetching the parts adds neither.
 */
async function createDownloadPlan(paths, basePath = '') {
  const normalizedList = (Array.isArray(paths) ? paths : [paths])
    .map((item) => normalizePath(item))
    .filter(Boolean);

  if (normalizedList.length === 0) {
    throw new Error('At least one path is required for download.');
  }

  const normalizedBase = normalizePath(basePath || '');

  return requestJson(shareScoped('/api/download/plan', normalizedBase || normalizedList[0]), {
    method: 'POST',
    body: JSON.stringify({
      items: normalizedList,
      basePath: normalizedBase,
    }),
  });
}

/**
 * @param {string} token the plan's token, which is not a share's
 * @param {string} part the part named by the plan
 * @param {string} [basePath] where the selection was taken from, so a plan made
 *   inside a share is fetched under that share's prefix like everything else
 */
const downloadPartPath = (token, part, basePath = '') =>
  `${shareScoped('/api/download/part', normalizePath(basePath || ''))}` +
  `/${encodeURIComponent(token)}/${encodeURIComponent(part)}`;

/**
 * Where one part of a plan is, as an address.
 *
 * For the browsers without a folder picker, where each part is taken by an
 * anchor carrying `download`: a navigation, not a request, so it must be a URL
 * and it must be a GET. The browser then streams it to disk itself.
 */
function downloadPartUrl(token, part, basePath = '') {
  return buildUrl(downloadPartPath(token, part, basePath));
}

/**
 * One part of a plan, as a response whose body is still arriving.
 *
 * For writing into a folder the reader picked: the bytes are piped from here
 * into a file handle, so a file larger than memory is never held in the page.
 */
function fetchDownloadPart(token, part, options = {}) {
  const { basePath = '', ...requestOptions } = options;
  return requestRaw(downloadPartPath(token, part, basePath), {
    method: 'GET',
    ...requestOptions,
  });
}

async function extractZip(relativePath, options = {}) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    throw new Error('An archive file path is required.');
  }
  // The endpoint streams NDJSON progress events (start/progress/done/error),
  // like the copy/move endpoints; `onEvent` receives each intermediate event.
  // The extraction runs in the server, so the stream is a window onto it:
  // `onTask` gets the operation's id, which is how it is stopped.
  return requestStream(shareScoped('/api/files/zip/extract', normalizedPath), {
    method: 'POST',
    body: JSON.stringify({
      path: normalizedPath,
      ...(options.destination === 'current' ? { destination: 'current' } : {}),
      ...(typeof options.password === 'string' ? { password: options.password } : {}),
    }),
    onEvent: watchingTheOperation(options),
    signal: options.signal,
    suppressErrorCodes: notARefusal(options.suppressErrorCodes),
  });
}

async function compressToZip(items, destination = '', name, options = {}) {
  const payload = {
    items: Array.isArray(items) ? items : [],
    destination: normalizePath(destination || ''),
  };
  if (typeof name === 'string' && name.trim()) {
    payload.name = name.trim();
  }

  // The endpoint streams NDJSON progress events (start/progress/done/error),
  // like the extract and copy/move endpoints, and the same window onto a
  // registered operation.
  return requestStream(
    shareScoped('/api/files/zip/compress', payload.destination || payload.items[0]),
    {
      method: 'POST',
      body: JSON.stringify(payload),
      onEvent: watchingTheOperation(options),
      signal: options.signal,
      suppressErrorCodes: notARefusal(),
    }
  );
}

async function search(path = '', q = '', limit, { signal } = {}) {
  const normalizedPath = normalizePath(path || '');
  const params = new URLSearchParams();
  if (normalizedPath) params.set('path', normalizedPath);
  if (typeof q === 'string' && q.trim()) params.set('q', q.trim());
  if (Number.isFinite(limit) && limit > 0) params.set('limit', String(limit));

  const endpoint = `${shareScoped('/api/search', normalizedPath)}?${params.toString()}`;
  // A search the caller has moved on from is aborted rather than waited out:
  // a deep one runs for seconds, and nobody is going to read its answer.
  return requestJson(endpoint, { method: 'GET', signal });
}

const getPreviewUrl = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    return null;
  }

  const params = new URLSearchParams({ path: normalizedPath });
  return buildUrl(`${shareScoped('/api/preview', normalizedPath)}?${params.toString()}`);
};

/**
 * What is inside a media file: its audio, video and subtitle tracks.
 *
 * The player does not transcode, so a track it cannot decode simply produces
 * nothing — a film with an AC-3 soundtrack plays in silence, and until this
 * existed the interface had no way to say why. Returns null when the server
 * cannot read the file, which the caller treats as "say nothing" rather than
 * "there is nothing".
 */
async function fetchMediaTracks(relativePath) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) return null;

  const params = new URLSearchParams({ path: normalizedPath });
  try {
    return await requestJson(
      `${shareScoped('/api/media/tracks', normalizedPath)}?${params.toString()}`,
      {
        method: 'GET',
        suppressErrorHandler: true,
      }
    );
  } catch (_) {
    // A file ffprobe will not read is not an error worth showing anyone; the
    // video still plays, and the extra information is simply unavailable.
    return null;
  }
}

/**
 * A URL for one subtitle track, converted to WebVTT.
 *
 * Handed straight to a `<track>` element rather than fetched, so the browser's
 * own caption menu drives it. That works because the API is served from the
 * same origin as the application; a `<track>` pointing somewhere else would
 * need CORS and would not carry the session cookie.
 *
 * @param {string} relativePath the media file
 * @param {{stream?: number, file?: string}} track as named by fetchMediaTracks:
 *   a stream index for an embedded track, a filename for a sidecar
 */
const getSubtitleUrl = (relativePath, track = {}) => {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) return null;

  const params = new URLSearchParams({ path: normalizedPath });
  if (typeof track.file === 'string' && track.file) {
    params.set('file', track.file);
  } else if (Number.isInteger(track.stream)) {
    params.set('stream', String(track.stream));
  } else {
    return null;
  }

  return buildUrl(`${shareScoped('/api/media/subtitle', normalizedPath)}?${params.toString()}`);
};

async function fetchPermissions(relativePath) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    throw new Error('A file path is required to fetch permissions.');
  }
  const encodedPath = encodePath(normalizedPath);
  return requestJson(`/api/permissions/${encodedPath}`, { method: 'GET' });
}

async function changePermissions(path, mode, recursive = false) {
  const normalizedPath = normalizePath(path);
  return requestJson('/api/permissions/chmod', {
    method: 'POST',
    body: JSON.stringify({
      path: normalizedPath,
      mode,
      recursive,
    }),
  });
}

async function changeOwnership(path, owner, group) {
  const normalizedPath = normalizePath(path);
  const payload = { path: normalizedPath };
  if (owner) payload.owner = owner;
  if (group) payload.group = group;

  return requestJson('/api/permissions/chown', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export {
  browse,
  getVolumes,
  getUsage,
  getFolderSizesBatch,
  refreshFolderSize,
  copyItems,
  moveItems,
  fetchRecentDestinations,
  fetchUnfinishedUploads,
  fetchKnownChecksums,
  takeChecksums,
  deleteItems,
  deleteItemsStream,
  getDeleteImpact,
  createFolder,
  reserveFolderUploadTarget,
  createFile,
  createOfficeDocument,
  renameItem,
  fetchFileContent,
  fetchSharedFileContent,
  saveSharedFileContent,
  saveFileContent,
  getRawFileUrl,
  fetchThumbnail,
  fetchMetadata,
  downloadItems,
  createDownloadPlan,
  downloadPartUrl,
  fetchDownloadPart,
  extractZip,
  compressToZip,
  search,
  getPreviewUrl,
  fetchMediaTracks,
  getSubtitleUrl,
  fetchPermissions,
  changePermissions,
  changeOwnership,
};
