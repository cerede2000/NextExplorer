import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The queue that keeps a folder responsive while its thumbnails load.
 *
 * A folder of two thousand pictures asks for two thousand thumbnails. Without a
 * bound the browser opens all of them at once and everything else — the
 * listing, the navigation, the next click — waits behind them. With a bound but
 * no cancellation, walking into another folder leaves the previous folder's
 * requests running, and their answers arrive to be written into a view that has
 * moved on.
 *
 * Neither the bound nor the cancellation was covered. CI puts this store at
 * sixty-six per cent, and this is the largest of what is missing: a
 * concurrency-limited queue with generation-based cancellation, whose failures
 * are a frozen folder or thumbnails from somewhere else.
 */

const browse = vi.fn();
const fetchThumbnail = vi.fn();

vi.mock('@/api', () => ({
  browse: (...args) => browse(...args),
  browseShare: vi.fn(),
  normalizePath: (path = '') => String(path).replace(/^\/+|\/+$/g, ''),
  copyItems: vi.fn(),
  moveItems: vi.fn(),
  deleteItems: vi.fn(),
  createFolder: vi.fn(),
  createFile: vi.fn(),
  renameItem: vi.fn(),
  saveFileContent: vi.fn(),
  fetchThumbnail: (...args) => fetchThumbnail(...args),
  extractZip: vi.fn(),
  compressToZip: vi.fn(),
  waitForOnlyOfficeActivityVersion: vi.fn(() => new Promise(() => {})),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    sortBy: { by: 'name', order: 'asc' },
    restoreFolderPreferences: vi.fn(),
  }),
}));

vi.mock('@/stores/features', () => ({
  // `ensureLoaded` and `onlyofficeEnabled` are what the activity poller asks
  // for as soon as a folder is fetched. Without them it rejects into nothing,
  // and the run reports unhandled errors beside every passing test.
  useFeaturesStore: () => ({
    ensureLoaded: vi.fn(async () => {}),
    onlyofficeEnabled: false,
    onlyoffice: false,
    features: {},
  }),
}));

vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({ thumbnailsEnabledForSession: true }),
}));

const { useFileStore } = await import('@/stores/fileStore');

/** The bound the store applies. Six at a time, and the seventh waits. */
const CONCURRENCY = 6;

/**
 * `supportsThumbnail` is what the listing sets for a file the server can make a
 * picture of; without it the store answers null before the queue is reached.
 */
const picture = (name) => ({ name, path: 'Photos', kind: 'jpg', supportsThumbnail: true });

/** A thumbnail request that never answers until the test lets it. */
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let store;

beforeEach(() => {
  setActivePinia(createPinia());
  browse.mockReset();
  fetchThumbnail.mockReset();
  store = useFileStore();
  store.currentPathItems = Array.from({ length: 12 }, (_, i) => picture(`p${i}.jpg`));
});

describe('how many thumbnails are asked for at once', () => {
  it('asks for no more than the limit', async () => {
    const pending = [];
    fetchThumbnail.mockImplementation(() => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    });

    store.currentPathItems.forEach((item) => store.ensureItemThumbnail(item));
    await settle();

    expect(fetchThumbnail).toHaveBeenCalledTimes(CONCURRENCY);
  });

  /** The queue has to drain, or a folder stops loading thumbnails after six. */
  it('starts the next one as each answers', async () => {
    const pending = [];
    fetchThumbnail.mockImplementation(() => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    });

    store.currentPathItems.forEach((item) => store.ensureItemThumbnail(item));
    await settle();
    pending[0].resolve({ thumbnail: 'data:image/webp;base64,AA' });
    await settle();

    expect(fetchThumbnail).toHaveBeenCalledTimes(CONCURRENCY + 1);
  });

  it('keeps draining until every one has been asked for', async () => {
    const pending = [];
    fetchThumbnail.mockImplementation(() => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    });

    store.currentPathItems.forEach((item) => store.ensureItemThumbnail(item));
    for (let i = 0; i < 12; i += 1) {
      await settle();
      pending[i]?.resolve({ thumbnail: 'data:image/webp;base64,AA' });
    }
    await settle();

    expect(fetchThumbnail).toHaveBeenCalledTimes(12);
  });

  /**
   * A failure has to free its slot as surely as a success does. Otherwise a
   * folder of unreadable files fills the queue and nothing loads again.
   */
  it('frees its place when a request fails', async () => {
    const pending = [];
    fetchThumbnail.mockImplementation(() => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    });

    store.currentPathItems.forEach((item) => store.ensureItemThumbnail(item).catch(() => {}));
    await settle();
    pending[0].reject(new Error('unreadable'));
    await settle();

    expect(fetchThumbnail).toHaveBeenCalledTimes(CONCURRENCY + 1);
  });
});

describe('asking twice for the same thumbnail', () => {
  it('asks the server once', async () => {
    fetchThumbnail.mockImplementation(() => deferred().promise);
    const item = store.currentPathItems[0];

    store.ensureItemThumbnail(item);
    store.ensureItemThumbnail(item);
    await settle();

    expect(fetchThumbnail).toHaveBeenCalledTimes(1);
  });
});

describe('walking into another folder', () => {
  const navigateAway = async () => {
    browse.mockResolvedValue({ items: [], access: { canUpload: true } });
    await store.fetchPathItems('Elsewhere');
  };

  it('abandons what was still queued', async () => {
    fetchThumbnail.mockImplementation(() => deferred().promise);
    store.currentPathItems.forEach((item) => store.ensureItemThumbnail(item));
    await settle();
    const askedBefore = fetchThumbnail.mock.calls.length;

    await navigateAway();
    await settle();

    expect(fetchThumbnail).toHaveBeenCalledTimes(askedBefore);
  });

  /**
   * Answered rather than left hanging: a caller awaiting a thumbnail for a
   * folder nobody is looking at any more should be released, not stalled.
   */
  it('answers the callers it abandoned', async () => {
    fetchThumbnail.mockImplementation(() => deferred().promise);
    const waiting = store.currentPathItems.map((item) => store.ensureItemThumbnail(item));
    await settle();

    await navigateAway();

    await expect(Promise.race([waiting[11], settle()])).resolves.toBeDefined();
  });

  /** And an abandoned request is not an error anybody needs to see. */
  it('does not turn an abandoned request into a failure', async () => {
    fetchThumbnail.mockImplementation(() => deferred().promise);
    const waiting = store.currentPathItems.map((item) => store.ensureItemThumbnail(item));
    await settle();

    await navigateAway();

    await expect(waiting[11]).resolves.toBeNull();
  });

  it('signals the requests that were already running', async () => {
    const signals = [];
    fetchThumbnail.mockImplementation((_path, options) => {
      signals.push(options?.signal);
      return deferred().promise;
    });
    store.currentPathItems.forEach((item) => store.ensureItemThumbnail(item).catch(() => {}));
    await settle();

    await navigateAway();

    expect(signals.filter(Boolean).some((signal) => signal.aborted)).toBe(true);
  });
});
