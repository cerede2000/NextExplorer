import { fetchThumbnail as fetchThumbnailApi } from '@/api';
import { useAppSettings } from '@/stores/appSettings';
import { isAbortError, itemKey, itemRelativePath } from './items';

// How many thumbnail HTTP requests the client keeps in flight at once. The
// backend keeps navigation responsive under load (enlarged libuv pool + niced
// ffmpeg/convert children + bounded background queue), so the client can feed
// it several requests concurrently instead of trickling them two at a time.
export const THUMBNAIL_REQUEST_CONCURRENCY = 6;

/**
 * A bounded queue of thumbnail requests, emptied on navigation.
 *
 * `cancel` makes every queued request resolve with null and aborts those in
 * flight: they belong to a folder the reader has left. A request that fails
 * for any other reason rejects.
 */
export const createThumbnailQueue = ({ concurrency = THUMBNAIL_REQUEST_CONCURRENCY } = {}) => {
  const requests = new Map();
  const queue = [];
  const activeControllers = new Set();
  let activeCount = 0;
  let generation = 0;

  const pump = () => {
    while (activeCount < concurrency && queue.length > 0) {
      const task = queue.shift();

      if (!task || task.generation !== generation) {
        task?.resolve?.(null);
        continue;
      }

      const controller = new AbortController();
      activeControllers.add(controller);
      activeCount += 1;

      task
        .run(controller.signal)
        .then(task.resolve)
        .catch((error) => {
          if (!isAbortError(error)) {
            task.reject(error);
            return;
          }
          task.resolve(null);
        })
        .finally(() => {
          activeCount = Math.max(0, activeCount - 1);
          activeControllers.delete(controller);
          requests.delete(task.key);
          pump();
        });
    }
  };

  const enqueue = (key, run) =>
    new Promise((resolve, reject) => {
      queue.push({ key, generation, run, resolve, reject });
      pump();
    });

  const cancel = () => {
    generation += 1;

    const queued = queue.splice(0);
    for (const task of queued) {
      requests.delete(task.key);
      task.resolve(null);
    }

    for (const controller of activeControllers) {
      controller.abort();
    }
  };

  return { requests, enqueue, cancel };
};

const thumbnailsEnabled = () => {
  try {
    return useAppSettings().thumbnailsEnabledForSession !== false;
  } catch (_) {
    // If settings store fails, fail open to avoid breaking UI, but do not spam
    return true;
  }
};

/**
 * Asking for the thumbnails of the entries on screen.
 *
 * @param {object} options
 * @param {(key: string) => object|undefined} options.findItemByKey  the entry
 *   on screen now, which a thumbnail is written onto when it arrives
 * @param {ReturnType<typeof createThumbnailQueue>} options.queue
 */
export const createThumbnails = ({ findItemByKey, queue }) => {
  const ensureItemThumbnail = async (item, { background = false } = {}) => {
    if (!item || !item.name) {
      return null;
    }

    const kind = (item.kind || '').toLowerCase();
    if (kind === 'directory' || kind === 'pdf') {
      return null;
    }

    // Check if item supports thumbnails (set by backend)
    if (!item.supportsThumbnail) {
      return null;
    }

    if (!thumbnailsEnabled()) {
      return null;
    }

    const key = itemKey(item);
    if (!key) {
      return null;
    }

    const existing = findItemByKey(key);
    if (existing?.thumbnail) {
      return existing.thumbnail;
    }

    let pending = queue.requests.get(key);
    if (!pending) {
      const relativePath = itemRelativePath(item);
      if (!relativePath) {
        return null;
      }

      pending = queue.enqueue(key, async (signal) => {
        try {
          const response = await fetchThumbnailApi(relativePath, {
            signal,
            retryNetworkErrors: false,
            background,
          });
          const thumbnail = response?.thumbnail || '';
          if (thumbnail) {
            const target = findItemByKey(key);
            if (target) {
              target.thumbnail = thumbnail;
            }
            return thumbnail;
          }
          // No thumbnail yet: only keep polling when the server reported the job
          // as pending. Anything else is a definitive "no thumbnail" (unsupported
          // type, generation failed) — mark it so the icon stops re-requesting.
          if (!response?.pending) {
            const target = findItemByKey(key);
            if (target) {
              target.thumbnailUnavailable = true;
            }
          }
          return null;
        } catch (error) {
          // Aborted on navigation is not a failure — allow a later attempt.
          if (isAbortError(error)) {
            return null;
          }
          // Hard failure (404 missing source, other 4xx/5xx). These are silent,
          // best-effort fetches; mark the item so we never loop on the error.
          const target = findItemByKey(key);
          if (target) {
            target.thumbnailUnavailable = true;
          }
          return null;
        }
      });

      queue.requests.set(key, pending);
    }

    return pending;
  };

  const prefetchItemThumbnail = async (item) => {
    if (!item || !item.name || item.kind === 'directory' || !item.supportsThumbnail) {
      return false;
    }

    try {
      const appSettings = useAppSettings();
      if (appSettings.thumbnailsEnabledForSession === false) return false;
    } catch (_) {
      return false;
    }

    const relativePath = itemRelativePath(item);
    if (!relativePath) return false;

    try {
      const response = await fetchThumbnailApi(relativePath, {
        background: true,
        retryNetworkErrors: false,
      });
      if (response?.thumbnail) {
        const target = findItemByKey(itemKey(item));
        if (target) target.thumbnail = response.thumbnail;
        return true;
      }
      return Boolean(response?.queued);
    } catch (_) {
      return false;
    }
  };

  return { ensureItemThumbnail, prefetchItemThumbnail };
};
