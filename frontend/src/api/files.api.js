import {
  requestJson,
  requestRaw,
  requestStream,
  normalizePath,
  encodePath,
  buildUrl,
} from './http';

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
 * Items per streamed copy or move request. Same reason as the deletion batch:
 * the whole selection in one body is refused as too large.
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
  for (const response of responses) {
    for (const share of Array.isArray(response?.shares) ? response.shares : []) {
      if (share?.id) sharesById.set(share.id, share);
    }
  }
  const shares = Array.from(sharesById.values());
  return { shareCount: shares.length, shares };
};

const mergeTransferResults = (results) => {
  if (!Array.isArray(results)) return results;
  const merged = { success: true, items: [] };
  for (const result of results) {
    if (Array.isArray(result?.items)) merged.items.push(...result.items);
    if (result?.destination != null) merged.destination = result.destination;
  }
  return merged;
};

async function browse(path = '', options = {}) {
  const normalizedPath = normalizePath(path);
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
  return requestJson(`/api/usage/${encodedPath}`, { method: 'GET' });
}

async function getFolderSizesBatch(paths = [], options = {}) {
  const normalizedPaths = (Array.isArray(paths) ? paths : [])
    .map((p) => normalizePath(p))
    .filter(Boolean);
  return requestJson('/api/folder-size/batch', {
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
  return requestJson(`/api/folder-size/refresh/${encodedPath}`, { ...options, method: 'POST' });
}

/**
 * Run one streamed operation over a large selection, a batch at a time.
 *
 * A single request carrying thousands of paths is refused as too large, but
 * the caller still drives one progress bar: the events of each batch are
 * rebased onto the whole selection, so the bar never restarts and never goes
 * backwards at a boundary. Percentages are computed from item counts, which
 * are known upfront — byte totals are not, since each batch only learns its
 * own when the server prepares it.
 */
async function streamInBatches(items, batchSize, runBatch, onEvent) {
  const all = Array.isArray(items) ? items : [];
  const emit = typeof onEvent === 'function' ? onEvent : null;

  if (all.length <= batchSize) return runBatch(all, emit);

  const results = [];
  let knownBytes = 0;
  let doneBytes = 0;

  for (let index = 0; index < all.length; index += batchSize) {
    const batch = all.slice(index, index + batchSize);
    const offset = index;
    const bytesBefore = doneBytes;

    // eslint-disable-next-line no-await-in-loop
    const result = await runBatch(batch, (event) => {
      if (!emit) return;
      if (event.type === 'start') {
        knownBytes += Number(event.totalBytes) || 0;
        // One start for the whole run, carrying what is known so far.
        if (offset === 0) {
          emit({ ...event, totalItems: all.length, totalBytes: knownBytes });
        }
        return;
      }
      if (event.type === 'progress') {
        const completedItems = offset + (Number(event.completedItems) || 0);
        doneBytes = bytesBefore + (Number(event.copiedBytes) || 0);
        emit({
          ...event,
          completedItems,
          copiedBytes: doneBytes,
          ...(knownBytes ? { totalBytes: knownBytes } : {}),
          percent: Math.round((completedItems / all.length) * 100),
        });
        return;
      }
      emit(event);
    });

    results.push(result);
  }

  return results;
}

async function copyItems(items, destination, options = {}) {
  const results = await streamInBatches(
    items,
    TRANSFER_BATCH_SIZE,
    (batch, onEvent) =>
      requestStream('/api/files/copy', {
        method: 'POST',
        body: JSON.stringify({ items: batch, destination }),
        onEvent,
        signal: options.signal,
      }),
    options.onEvent
  );
  return mergeTransferResults(results);
}

async function moveItems(items, destination, options = {}) {
  const results = await streamInBatches(
    items,
    TRANSFER_BATCH_SIZE,
    (batch, onEvent) =>
      requestStream('/api/files/move', {
        method: 'POST',
        body: JSON.stringify({ items: batch, destination }),
        onEvent,
        signal: options.signal,
      }),
    options.onEvent
  );
  return mergeTransferResults(results);
}

async function deleteItems(items) {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (normalizedItems.length <= DELETE_BATCH_SIZE) {
    return requestJson('/api/files', {
      method: 'DELETE',
      body: JSON.stringify({ items: normalizedItems }),
    });
  }

  const deletedItems = [];
  for (let index = 0; index < normalizedItems.length; index += DELETE_BATCH_SIZE) {
    const batch = normalizedItems.slice(index, index + DELETE_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const response = await requestJson('/api/files', {
      method: 'DELETE',
      body: JSON.stringify({ items: batch }),
    });
    deletedItems.push(...(Array.isArray(response?.items) ? response.items : []));
  }

  return { success: true, items: deletedItems };
}

async function deleteItemsStream(items, options = {}) {
  const results = await streamInBatches(
    items,
    DELETE_STREAM_BATCH_SIZE,
    (batch, onEvent) =>
      requestStream('/api/files/delete-stream', {
        method: 'POST',
        body: JSON.stringify({ items: batch }),
        onEvent,
        signal: options.signal,
      }),
    options.onEvent
  );

  if (!Array.isArray(results)) return results;
  return {
    success: true,
    items: results.flatMap((result) => (Array.isArray(result?.items) ? result.items : [])),
  };
}

async function getDeleteImpact(items) {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (normalizedItems.length <= DELETE_STREAM_BATCH_SIZE) {
    return summarizeDeleteImpact([
      await requestJson('/api/files/delete-impact', {
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
      requestJson('/api/files/delete-impact', {
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

  return requestJson('/api/files/folder', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function reserveFolderUploadTarget(destination, sourceRoot) {
  const uploadTo = normalizePath(destination || '');
  if (!uploadTo || typeof sourceRoot !== 'string' || !sourceRoot.trim()) {
    throw new Error('A destination and folder name are required to start a folder upload.');
  }

  return requestJson('/api/upload/folder-session', {
    method: 'POST',
    body: JSON.stringify({ uploadTo, sourceRoot }),
  });
}

async function createFile(destination, name) {
  const normalizedDestination = normalizePath(destination || '');
  const payload = { path: normalizedDestination };

  if (typeof name === 'string' && name.trim()) {
    payload.name = name;
  }

  return requestJson('/api/files/file', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function renameItem(path, name, newName) {
  const normalizedPath = normalizePath(path || '');
  return requestJson('/api/files/rename', {
    method: 'POST',
    body: JSON.stringify({
      path: normalizedPath,
      name,
      newName,
    }),
  });
}

async function fetchFileContent(path) {
  return requestJson('/api/editor', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
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
  return buildUrl(`/api/raw?${params.toString()}`);
}

async function fetchThumbnail(relativePath, options = {}) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    throw new Error('A file path is required to fetch a thumbnail.');
  }
  const encodedPath = encodePath(normalizedPath);
  // Thumbnails are best-effort/background: never surface a global error toast on
  // a missing source. Callers inspect the thrown error's statusCode to decide
  // whether to retry.
  return requestJson(`/api/thumbnails/${encodedPath}`, {
    method: 'GET',
    suppressErrorHandler: true,
    ...options,
  });
}

async function fetchMetadata(relativePath) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    throw new Error('A file path is required to fetch metadata.');
  }
  const encodedPath = encodePath(normalizedPath);
  return requestJson(`/api/metadata/${encodedPath}`, { method: 'GET' });
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
  return requestRaw('/api/download', {
    method: 'POST',
    body: JSON.stringify({
      items: normalizedList,
      basePath: normalizedBase,
    }),
  });
}

async function extractZip(relativePath, options = {}) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    throw new Error('An archive file path is required.');
  }
  // The endpoint streams NDJSON progress events (start/progress/done/error),
  // like the copy/move endpoints; `onEvent` receives each intermediate event.
  return requestStream('/api/files/zip/extract', {
    method: 'POST',
    body: JSON.stringify({
      path: normalizedPath,
      ...(options.destination === 'current' ? { destination: 'current' } : {}),
      ...(typeof options.password === 'string' ? { password: options.password } : {}),
    }),
    onEvent: options.onEvent,
    signal: options.signal,
    suppressErrorCodes: options.suppressErrorCodes,
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
  // like the extract and copy/move endpoints.
  return requestStream('/api/files/zip/compress', {
    method: 'POST',
    body: JSON.stringify(payload),
    onEvent: options.onEvent,
    signal: options.signal,
  });
}

async function search(path = '', q = '', limit) {
  const normalizedPath = normalizePath(path || '');
  const params = new URLSearchParams();
  if (normalizedPath) params.set('path', normalizedPath);
  if (typeof q === 'string' && q.trim()) params.set('q', q.trim());
  if (Number.isFinite(limit) && limit > 0) params.set('limit', String(limit));

  const endpoint = `/api/search?${params.toString()}`;
  return requestJson(endpoint, { method: 'GET' });
}

const getPreviewUrl = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) {
    return null;
  }

  const params = new URLSearchParams({ path: normalizedPath });
  return buildUrl(`/api/preview?${params.toString()}`);
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
  deleteItems,
  deleteItemsStream,
  getDeleteImpact,
  createFolder,
  reserveFolderUploadTarget,
  createFile,
  renameItem,
  fetchFileContent,
  fetchSharedFileContent,
  saveSharedFileContent,
  saveFileContent,
  getRawFileUrl,
  fetchThumbnail,
  fetchMetadata,
  downloadItems,
  extractZip,
  compressToZip,
  search,
  getPreviewUrl,
  fetchPermissions,
  changePermissions,
  changeOwnership,
};
