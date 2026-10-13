import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An upload that comes back to where it stopped.
 *
 * It cannot carry on by itself the way a copy in the server does: the bytes are
 * in the browser, so when the tab goes away nobody is sending any. What it can
 * do is resume — the server keeps the part that arrived for a day, and tus asks
 * where it got to — and that needs the address of the upload to outlive the
 * page. Without it a reader whose connection dropped at ninety per cent sent
 * the whole file again.
 *
 * The part worth a test of its own is what tells one upload from another. tus
 * looks a previous upload up by a fingerprint, and Uppy builds that fingerprint
 * out of the file and the *endpoint* — where the file is going travels in the
 * metadata, which the fingerprint never sees. So the same file sent to two
 * folders had one fingerprint between them: interrupt the first, start the
 * second, and the second resumes the first and lands the file in a folder
 * nobody sent it to. Neither half of that can be seen from the other.
 */

const handlers = new Map();
const uppyCalls = [];

// Everything a fake Uppy is asked for answers with a function, so this test does
// not have to keep a list of the engine's calls up to date; what it does keep is
// `on`, which is the one thing it has to be able to fire.
const makeUppy = () =>
  new Proxy(
    {
      on: (event, handler) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
    },
    {
      get: (target, property) => {
        if (property in target) return target[property];
        return (...args) => {
          uppyCalls.push([String(property), ...args]);
          return undefined;
        };
      },
    }
  );

vi.mock('@uppy/core', () => ({
  default: class {
    constructor() {
      return makeUppy();
    }
  },
}));
vi.mock('@uppy/xhr-upload', () => ({ default: { name: 'XHRUpload' } }));
vi.mock('@uppy/tus', () => ({ default: { name: 'Tus' } }));

const fileStore = vi.hoisted(() => ({
  currentPath: 'Docs/2026',
  currentPathData: { canUpload: true },
  refresh: vi.fn(() => Promise.resolve()),
  fetchPathItems: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => fileStore }));

vi.mock('@/stores/uppyStore', () => ({ useUppyStore: () => ({ uppy: null }) }));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification: vi.fn() }),
}));
vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({
    loaded: true,
    // Chunked uploads on: they are the only ones that can be resumed, which is
    // what this file is about.
    state: { uploads: { chunkedEnabled: true, chunkSizeBytes: 8 * 1024 * 1024 } },
    ensureLoaded: () => Promise.resolve(),
  }),
}));
vi.mock('@/stores/volumeUsage', () => ({
  useVolumeUsageStore: () => ({ scheduleRefresh: vi.fn() }),
}));
vi.mock('@/stores/folderSize', () => ({
  useFolderSizeStore: () => ({ scheduleRefresh: vi.fn() }),
}));
vi.mock('@/stores/operationTasks', () => ({
  useOperationTasksStore: () => ({
    startOperation: vi.fn(() => 'op-1'),
    updateOperation: vi.fn(),
    finishOperation: vi.fn(),
  }),
}));

vi.mock('@/api', () => ({
  apiBase: '',
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
  reserveFolderUploadTarget: vi.fn(),
}));

import { createUploadEngine } from './uploadEngine';

const fire = async (event, ...args) => {
  for (const handler of handlers.get(event) || []) await handler(...args);
};

const called = (method) => uppyCalls.filter(([name]) => name === method);

/** The options the resumable uploader was installed with. */
const tusOptions = () => {
  const use = called('use').find(([, plugin]) => plugin?.name === 'Tus');
  return use?.[2] || null;
};

/** What was set on one file, merged as the engine sets it. */
const stateOf = (fileId) =>
  called('setFileState')
    .filter(([, id]) => id === fileId)
    .reduce((all, [, , state]) => ({ ...all, ...state }), {});

const metaOf = (fileId) =>
  called('setFileMeta')
    .filter(([, id]) => id === fileId)
    .reduce((all, [, , meta]) => ({ ...all, ...meta }), {});

const aFile = (id, name) => ({
  id,
  name,
  data: { name, size: 1024, lastModified: 1760000000000 },
  meta: {},
});

beforeEach(async () => {
  vi.useFakeTimers();
  handlers.clear();
  uppyCalls.length = 0;
  fileStore.currentPath = 'Docs/2026';
  await createUploadEngine();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the resumable uploader', () => {
  it('remembers where an upload got to, so the same file continues', () => {
    expect(tusOptions()).toMatchObject({ storeFingerprintForResuming: true });
    // And forgets it once the file has arrived: a finished upload is not one to
    // come back to.
    expect(tusOptions()).toMatchObject({ removeFingerprintOnSuccess: true });
  });

  it('sends what tells one file from another of the same name and size', async () => {
    expect(tusOptions().allowedMetaFields).toContain('lastModified');

    await fire('file-added', aFile('f1', 'film.mkv'));

    expect(metaOf('f1')).toMatchObject({
      uploadTo: 'Docs/2026',
      lastModified: '1760000000000',
    });
  });

  /**
   * The destination, in the one place the fingerprint reads: the endpoint.
   * Nothing on the server reads it — where the file goes is the metadata's, and
   * is authorized from there.
   */
  it('names the folder in the address it is created at', async () => {
    await fire('file-added', aFile('f1', 'film.mkv'));

    expect(stateOf('f1').tus.endpoint).toBe('/api/upload/tus?for=Docs%2F2026');
  });

  it('gives two folders two addresses, so one upload never resumes the other', async () => {
    await fire('file-added', aFile('f1', 'film.mkv'));
    fileStore.currentPath = 'Archive';
    await fire('file-added', aFile('f2', 'film.mkv'));

    expect(stateOf('f1').tus.endpoint).not.toBe(stateOf('f2').tus.endpoint);
    expect(stateOf('f2').tus.endpoint).toBe('/api/upload/tus?for=Archive');
  });

  it('keeps the address of an upload already under way', async () => {
    const file = { ...aFile('f1', 'film.mkv'), tus: { uploadUrl: '/api/upload/tus/abc' } };

    await fire('file-added', file);

    expect(stateOf('f1').tus).toMatchObject({
      uploadUrl: '/api/upload/tus/abc',
      endpoint: '/api/upload/tus?for=Docs%2F2026',
    });
  });
});
