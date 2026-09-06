import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The uploader's decisions, driven through Uppy's own events.
 *
 * 865 lines measured at two per cent, and what lives in them is not cosmetic: a
 * permission checked at the wrong moment uploads into a folder somebody was
 * refused, and the automatic fallback rewrites how *every* later upload from
 * this browser goes out — a decision remembered in localStorage that nobody
 * asked for and nobody sees.
 *
 * The decisions that could be lifted out already were (uploadTarget,
 * uploadMode, uploadFallback, all tested on their own). What is left is the
 * wiring, and wiring is only true if the events actually fire, so this drives a
 * real Uppy instance with its two uploader plugins replaced by ones that never
 * send anything.
 */

const uploaders = vi.hoisted(() => ({ installed: [] }));

const fakes = vi.hoisted(() => {
  const makePlugin = (pluginId) =>
    class FakeUploader {
      constructor(uppy, opts = {}) {
        this.uppy = uppy;
        this.opts = { ...opts };
        this.id = opts.id || pluginId;
        this.type = 'uploader';
      }

      install() {
        // Registered so Uppy considers the batch handled, and hangs: an upload
        // in flight is the state every event below happens during.
        this.uppy.addUploader(() => new Promise(() => {}));
        this.constructor.registry.installed.push(this);
      }

      uninstall() {}

      setOptions(next) {
        this.opts = { ...this.opts, ...next };
      }
    };

  return { makePlugin };
});

vi.mock('@uppy/xhr-upload', () => {
  const Plugin = fakes.makePlugin('XHRUpload');
  Plugin.registry = uploaders;
  return { default: Plugin };
});

vi.mock('@uppy/tus', () => {
  const Plugin = fakes.makePlugin('Tus');
  Plugin.registry = uploaders;
  return { default: Plugin };
});

vi.mock('@uppy/drop-target', () => ({
  default: class DropTarget {
    constructor(uppy, opts = {}) {
      this.uppy = uppy;
      this.opts = opts;
      this.id = 'DropTarget';
      this.type = 'acquirer';
    }
    install() {}
    uninstall() {}
  },
}));

const api = vi.hoisted(() => ({
  reserveFolderUploadTarget: vi.fn(async (_to, sourceRoot) => ({ targetRoot: `${sourceRoot} (1)` })),
}));

vi.mock('@/api', () => ({
  apiBase: '',
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
  reserveFolderUploadTarget: (...args) => api.reserveFolderUploadTarget(...args),
}));

const stores = vi.hoisted(() => ({
  file: {},
  notifications: {},
  settings: {},
  volume: {},
  folder: {},
  tasks: {},
}));

vi.mock('@/stores/fileStore', () => ({ useFileStore: () => stores.file }));
vi.mock('@/stores/notifications', () => ({ useNotificationsStore: () => stores.notifications }));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => stores.settings }));
vi.mock('@/stores/volumeUsage', () => ({ useVolumeUsageStore: () => stores.volume }));
vi.mock('@/stores/folderSize', () => ({ useFolderSizeStore: () => stores.folder }));
vi.mock('@/stores/operationTasks', () => ({ useOperationTasksStore: () => stores.tasks }));

const { useFileUploader, useUppyDropTarget, getUploadFallbackMiB, resetUploadFallback } =
  await import('./fileUploader');
const { useUppyStore } = await import('@/stores/uppyStore');

const MiB = 1024 * 1024;
const FALLBACK_KEY = 'nextExplorer_upload_fallback_chunk_mib';

let wrapper = null;

let uploader = null;

/** Mounted the way the app mounts it, and handing back Uppy to drive. */
const mountUploader = async () => {
  wrapper = mount(
    defineComponent({
      setup: () => {
        uploader = useFileUploader();
        return uploader;
      },
      render: () => null,
    })
  );
  await vi.advanceTimersByTimeAsync(0);
  return useUppyStore().uppy;
};

/** A file as a folder picker hands it over, path and all. */
const pickedFile = (relativePath) => {
  const name = relativePath.split('/').pop();
  const file = new File(['hello'], name, { type: 'text/plain' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
};

/**
 * The picker opened, something chosen, the dialog closed.
 *
 * `openDialog` resolves from inside the input's own change handler, which is
 * the only way its work can be waited on.
 */
const pick = async (options, files) => {
  const pending = uploader.openDialog(options);
  await settle();
  const input = document.querySelector('input[type=file]');
  const event = { target: { files, value: 'C:\\fakepath\\note.txt' } };
  await input.onchange(event);
  await pending;
  await settle();
  return { input, event };
};

/** Let the microtasks and any zero-delay timer run. */
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/**
 * A file as an Uppy event carries it — big enough for a proxy to cut off.
 *
 * Built by hand rather than added to Uppy, because a real 100 MiB Blob would
 * cost a hundred megabytes to assert on a number.
 */
const largeFile = (overrides = {}) => ({
  id: 'file-big',
  name: 'archive.zip',
  type: 'application/zip',
  size: 100 * MiB,
  data: new Blob(['x']),
  meta: { uploadTo: 'Docs' },
  progress: { bytesUploaded: 0 },
  ...overrides,
});

const lastToast = () => stores.notifications.addNotification.mock.calls.at(-1)?.[0];
const installedIds = () => uploaders.installed.map((plugin) => plugin.id);
const lastTus = () => uploaders.installed.filter((plugin) => plugin.id === 'Tus').at(-1);

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  localStorage.clear();
  uploaders.installed = [];
  api.reserveFolderUploadTarget.mockClear();

  Object.assign(stores.file, {
    currentPath: 'Docs',
    currentPathData: null,
    fetchPathItems: vi.fn(async () => {}),
  });
  Object.assign(stores.notifications, { addNotification: vi.fn() });
  Object.assign(stores.settings, {
    // Auto-fallback watching direct uploads: the mode every browser starts in.
    state: { uploads: { chunkedAutoFallback: true } },
    userSettings: {},
    ensureLoaded: vi.fn(async () => {}),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [{ name: 'note.txt', copiedBytes: 3, totalBytes: 5 }] }),
    }))
  );
  Object.assign(stores.volume, { scheduleRefresh: vi.fn() });
  Object.assign(stores.folder, { scheduleRefresh: vi.fn() });
  Object.assign(stores.tasks, {
    startOperation: vi.fn(() => 'op-1'),
    updateOperation: vi.fn(),
    finishOperation: vi.fn(),
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the size this browser has learned to upload in', () => {
  it('is nothing until a direct upload has failed', () => {
    expect(getUploadFallbackMiB()).toBeNull();
  });

  it('is read back once one has', () => {
    localStorage.setItem(FALLBACK_KEY, '32');
    expect(getUploadFallbackMiB()).toBe(32);
  });

  it('is ignored when it is not a size', () => {
    localStorage.setItem(FALLBACK_KEY, 'sixteen');
    expect(getUploadFallbackMiB()).toBeNull();
  });

  it('is forgotten on request, which is how the settings screen reverts it', () => {
    localStorage.setItem(FALLBACK_KEY, '32');
    resetUploadFallback();
    expect(getUploadFallbackMiB()).toBeNull();
  });
});

describe('a large direct upload that fails', () => {
  it('learns a chunk size instead of showing an error', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile(), new Error('413 Request Entity Too Large'), {
      status: 413,
    });
    await settle();

    expect(getUploadFallbackMiB()).toBe(96);
    expect(stores.notifications.addNotification).not.toHaveBeenCalled();
  });

  /** Whatever the proxy accepted before giving up is an upper bound on its limit. */
  it('starts below what the proxy actually swallowed', async () => {
    const uppy = await mountUploader();

    uppy.emit(
      'upload-error',
      largeFile({ progress: { bytesUploaded: 40 * MiB } }),
      new Error('network error'),
      null
    );
    await settle();

    expect(getUploadFallbackMiB()).toBe(32);
  });

  it('switches the next upload over to chunks of that size', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile(), new Error('boom'), { status: 413 });
    await settle();

    expect(installedIds()).toEqual(['XHRUpload', 'Tus']);
    expect(lastTus().opts.chunkSize).toBe(96 * MiB);
  });

  it('sends the file again with the destination it was given', async () => {
    const uppy = await mountUploader();
    const file = largeFile({ meta: { uploadTo: 'Archive', relativePath: 'archive.zip' } });

    uppy.emit('upload-error', file, new Error('boom'), { status: 413 });
    await settle();

    const resent = uppy.getFiles().find((candidate) => candidate.name === 'archive.zip');
    expect(resent.meta.uploadTo).toBe('Archive');
  });

  it('steps down when the size it learned fails too', async () => {
    localStorage.setItem(FALLBACK_KEY, '32');
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile(), new Error('boom'), { status: 413 });
    await settle();

    expect(getUploadFallbackMiB()).toBe(16);
  });

  /**
   * At the smallest rung the problem is not body size. Staying in chunked mode
   * would slow every upload from this browser for ever over an unrelated fault.
   */
  it('gives up at the smallest size, reverts to direct, and says so', async () => {
    localStorage.setItem(FALLBACK_KEY, '8');
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile(), new Error('Disk on fire'), { status: 500 });
    await settle();

    expect(getUploadFallbackMiB()).toBeNull();
    expect(lastToast().heading).toBe('Disk on fire');
  });

  it('sends the file again once, however many errors it emits', async () => {
    const uppy = await mountUploader();
    const file = largeFile();

    uppy.emit('upload-error', file, new Error('boom'), { status: 413 });
    uppy.emit('upload-error', file, new Error('boom'), { status: 413 });
    await settle();

    expect(uppy.getFiles()).toHaveLength(1);
    expect(getUploadFallbackMiB()).toBe(96);
  });
});

describe('a failure chunking cannot fix', () => {
  const refusals = [
    ['a sign-in that expired', 401],
    ['a folder the person cannot write to', 403],
    ['a volume with no room left', 507],
  ];

  it.each(refusals)('is shown rather than retried smaller: %s', async (_why, status) => {
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile(), new Error('Refused'), { status });
    await settle();

    expect(getUploadFallbackMiB()).toBeNull();
    expect(lastToast().heading).toBe('Refused');
  });

  it('is shown for a small file, which no chunk size would have helped', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile({ size: 1024 }), new Error('Refused'), { status: 500 });
    await settle();

    expect(getUploadFallbackMiB()).toBeNull();
    expect(lastToast().heading).toBe('Refused');
  });
});

describe('a direct upload that stops sending without failing', () => {
  it('falls back on the stall, since no error is ever coming', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-stalled', new Error('timed out'), [largeFile()]);
    await settle();

    expect(getUploadFallbackMiB()).toBe(96);
  });

  it('is left alone once this browser is already uploading in chunks', async () => {
    localStorage.setItem(FALLBACK_KEY, '32');
    const uppy = await mountUploader();

    uppy.emit('upload-stalled', new Error('timed out'), [largeFile()]);
    await settle();

    expect(getUploadFallbackMiB()).toBe(32);
  });
});

describe('what the person is told when an upload really fails', () => {
  it('is what the server said', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile({ size: 1024 }), new Error('Upload failed'), {
      status: 400,
      body: { error: { message: 'Name already taken', requestId: 'req-7', statusCode: 409 } },
    });
    await settle();

    expect(lastToast()).toMatchObject({ heading: 'Name already taken', requestId: 'req-7' });
  });

  /** "Failed to fetch" tells nobody anything about their own network. */
  it('is a sentence about the connection when the connection dropped', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile({ size: 1024 }), new TypeError('Failed to fetch'), null);
    await settle();

    expect(lastToast().heading).toBe('Upload interrupted because the server connection was lost.');
  });

  it('is said once, not once per file of a folder', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile({ id: 'a', size: 1024 }), new Error('Refused'), {
      status: 400,
    });
    uppy.emit('upload-error', largeFile({ id: 'b', size: 1024 }), new Error('Refused'), {
      status: 400,
    });
    await settle();

    expect(stores.notifications.addNotification).toHaveBeenCalledTimes(1);
  });

  /**
   * Uppy re-emits every per-file error on its own channel. Repeating them would
   * show a toast for a fallback that is about to succeed silently.
   */
  it('is not repeated when Uppy re-announces the same per-file error', async () => {
    const uppy = await mountUploader();

    uppy.emit('error', Object.assign(new Error('Failed to upload archive.zip'), {
      isUserFacing: true,
    }));
    await settle();

    expect(stores.notifications.addNotification).not.toHaveBeenCalled();
  });

  it('is shown for an error that belongs to nothing in particular', async () => {
    const uppy = await mountUploader();

    uppy.emit('error', new Error('Uppy fell over'));
    await settle();

    expect(lastToast().heading).toBe('Uppy fell over');
  });
});

describe('telling a lost connection from a refused upload', () => {
  const cases = [
    ['Chrome', 'Failed to fetch'],
    ['Safari', 'Load failed'],
    ['tus quoting Safari', 'tus: failed to upload chunk at offset 0, caused by Load failed'],
    ['Uppy wrapping XHR', 'This looks like a network error, the endpoint might be blocked'],
  ];

  it.each(cases)('reads %s as the connection dropping', async (_who, message) => {
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile({ size: 1024 }), new Error(message), null);
    await settle();

    expect(lastToast().heading).toBe('Upload interrupted because the server connection was lost.');
  });

  /**
   * "Upload failed" contains "load failed". Reading it as a network fault would
   * answer a refusal the server explained with a sentence about the network.
   */
  it('does not read a plain refusal as one', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-error', largeFile({ size: 1024 }), new Error('Upload failed'), {
      status: 409,
      body: { error: { message: 'A file with that name already exists' } },
    });
    await settle();

    expect(lastToast().heading).toBe('A file with that name already exists');
  });
});

describe('a file offered where uploading is not allowed', () => {
  const readOnlyShare = {
    canUpload: false,
    shareInfo: { accessMode: 'readonly' },
  };

  const offer = async (uppy, name = 'note.txt') =>
    uppy.addFile({ name, type: 'text/plain', data: new File(['hello'], name) });

  it('is dropped, with the reason the share gave', async () => {
    stores.file.currentPathData = readOnlyShare;
    const uppy = await mountUploader();

    await offer(uppy);
    await settle();

    expect(uppy.getFiles()).toHaveLength(0);
    expect(lastToast().heading).toBe('This share is read-only. Uploads are disabled.');
  });

  it('is dropped before any upload task is opened for it', async () => {
    stores.file.currentPathData = readOnlyShare;
    const uppy = await mountUploader();

    await offer(uppy);
    await settle();

    expect(stores.tasks.startOperation).not.toHaveBeenCalled();
  });

  /** A share whose metadata has not arrived yet fails closed. */
  it('is dropped inside a share that has not loaded yet', async () => {
    stores.file.currentPath = 'share/abc';
    stores.file.currentPathData = null;
    const uppy = await mountUploader();

    await offer(uppy);
    await settle();

    expect(uppy.getFiles()).toHaveLength(0);
    expect(lastToast().heading).toBe('Share is still loading. Please try again in a moment.');
  });
});

describe('a file offered where uploading is allowed', () => {
  const offer = (uppy, name, data) =>
    uppy.addFile({ name, type: 'text/plain', data: data || new File(['hello'], name) });

  it('is told where it is going', async () => {
    const uppy = await mountUploader();

    offer(uppy, 'note.txt');
    await settle();

    expect(uppy.getFiles()[0].meta).toMatchObject({
      uploadTo: 'Docs',
      relativePath: 'note.txt',
      resolvedRelativePath: '',
    });
  });

  /**
   * Every field Uppy is allowed to send is stringified whether the file carries
   * it or not, so one left unset arrives at the server as the word "undefined".
   */
  it('carries an empty folder path rather than none at all', async () => {
    const uppy = await mountUploader();

    offer(uppy, 'note.txt');
    await settle();

    expect(uppy.getFiles()[0].meta.resolvedRelativePath).toBe('');
  });

  it('opens an upload task somebody can watch and cancel', async () => {
    const uppy = await mountUploader();

    offer(uppy, 'note.txt');
    await settle();

    expect(stores.tasks.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'upload', name: 'note.txt', destination: 'Docs' })
    );
  });

  it('is dropped silently when it is one of the operating system"s own', async () => {
    const uppy = await mountUploader();

    offer(uppy, '.DS_Store');
    await settle();

    expect(uppy.getFiles()).toHaveLength(0);
    expect(stores.notifications.addNotification).not.toHaveBeenCalled();
  });
});

describe('a batch that starts after the permission changed', () => {
  const queued = (uploadTo) => [{ id: 'q1', name: 'a.txt', meta: { uploadTo } }];

  it('is cancelled when it was headed for the folder now refusing it', async () => {
    const uppy = await mountUploader();
    const cancelAll = vi.spyOn(uppy, 'cancelAll');
    stores.file.currentPathData = { canUpload: false };

    uppy.emit('upload', 'batch-1', queued('Docs'));
    await settle();

    expect(cancelAll).toHaveBeenCalled();
    expect(lastToast().heading).toBe('You do not have permission to upload to this location.');
  });

  /**
   * Somebody browsing elsewhere while an upload runs must not have it cancelled
   * because the folder they happen to be looking at refuses uploads.
   */
  it('is left alone when it was headed somewhere else', async () => {
    const uppy = await mountUploader();
    const cancelAll = vi.spyOn(uppy, 'cancelAll');
    stores.file.currentPathData = { canUpload: false };

    uppy.emit('upload', 'batch-1', queued('Archive'));
    await settle();

    expect(cancelAll).not.toHaveBeenCalled();
    expect(stores.notifications.addNotification).not.toHaveBeenCalled();
  });
});

describe('keeping the screen in step with the uploads', () => {
  it('reports progress against the task it opened', async () => {
    const uppy = await mountUploader();
    uppy.addFile({ name: 'note.txt', type: 'text/plain', data: new File(['hello'], 'note.txt') });
    await settle();
    const [file] = uppy.getFiles();

    uppy.emit('upload-progress', file, { bytesUploaded: 10 * MiB, bytesTotal: 100 * MiB });
    await settle();

    expect(stores.tasks.updateOperation).toHaveBeenCalledWith('op-1', {
      totalBytes: 100 * MiB,
      copiedBytes: 10 * MiB,
    });
  });

  /**
   * Every byte is out and the bar sits at 100%, but the server may still be
   * copying the file onto the destination volume. From here it is the only one
   * who knows how far along it is, so the task starts asking.
   */
  it('asks the server how the writing is going once the bytes are all sent', async () => {
    const uppy = await mountUploader();
    uppy.addFile({ name: 'note.txt', type: 'text/plain', data: new File(['hello'], 'note.txt') });
    await settle();
    const [file] = uppy.getFiles();

    uppy.emit('upload-progress', file, { bytesUploaded: 5, bytesTotal: 5 });
    await settle(1000);

    expect(fetch).toHaveBeenCalledWith(
      '/api/upload/finalizations',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(stores.tasks.updateOperation).toHaveBeenCalledWith(
      'op-1',
      expect.objectContaining({ finalizing: true, finalizedBytes: 3, finalizedTotalBytes: 5 })
    );
  });

  it('stops asking once nothing is waiting on the answer', async () => {
    const uppy = await mountUploader();
    uppy.addFile({ name: 'note.txt', type: 'text/plain', data: new File(['hello'], 'note.txt') });
    await settle();
    const [file] = uppy.getFiles();
    uppy.emit('upload-progress', file, { bytesUploaded: 5, bytesTotal: 5 });
    await settle(1000);

    uppy.emit('upload-success', file, {});
    await settle(3000);
    const asked = fetch.mock.calls.length;
    await settle(3000);

    expect(fetch.mock.calls.length).toBe(asked);
  });

  /**
   * A folder upload finishes one file at a time. Refreshing on each one aborts
   * the listing request the previous file just started.
   */
  it('refreshes the listing once for a burst of finished files', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-success', { id: 'a' }, {});
    uppy.emit('upload-success', { id: 'b' }, {});
    uppy.emit('upload-success', { id: 'c' }, {});
    await settle(1000);

    expect(stores.file.fetchPathItems).toHaveBeenCalledTimes(1);
  });

  it('refreshes what the volume and the folder now weigh', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-success', { id: 'a' }, {});
    await settle(1000);

    expect(stores.volume.scheduleRefresh).toHaveBeenCalled();
    expect(stores.folder.scheduleRefresh).toHaveBeenCalled();
  });

  it('waits before refreshing, so a folder still arriving is not chased', async () => {
    const uppy = await mountUploader();

    uppy.emit('upload-success', { id: 'a' }, {});
    await settle(300);

    expect(stores.file.fetchPathItems).not.toHaveBeenCalled();
  });
});

describe('choosing files from the picker', () => {
  it('is refused outright where uploading is not allowed', async () => {
    stores.file.currentPathData = { canUpload: false };
    await mountUploader();

    await uploader.openDialog({});
    await settle();

    expect(lastToast().heading).toBe('You do not have permission to upload to this location.');
  });

  it('tells the picker to ask for a folder when that is what was wanted', async () => {
    await mountUploader();

    const pending = uploader.openDialog({ directory: true });
    await settle();
    const input = document.querySelector('input[type=file]');

    expect(input.webkitdirectory).toBe(true);
    input.onchange({ target: { files: [], value: '' } });
    await pending;
  });

  it('hands single files straight to Uppy', async () => {
    const uppy = await mountUploader();

    await pick({}, [new File(['hello'], 'note.txt')]);

    expect(uppy.getFiles().map((file) => file.name)).toEqual(['note.txt']);
    expect(api.reserveFolderUploadTarget).not.toHaveBeenCalled();
  });

  it('drops the operating system"s own files before they reach Uppy', async () => {
    const uppy = await mountUploader();

    await pick({}, [new File([''], '.DS_Store'), new File(['hello'], 'note.txt')]);

    expect(uppy.getFiles().map((file) => file.name)).toEqual(['note.txt']);
  });

  it('lets the same file be chosen again', async () => {
    await mountUploader();

    const { event } = await pick({}, [new File(['hello'], 'note.txt')]);

    expect(event.target.value).toBe('');
  });
});

describe('choosing a folder from the picker', () => {
  const tree = () => [pickedFile('Docs/a.txt'), pickedFile('Docs/sub/b.txt')];

  /**
   * The server decides the destination name so an existing folder is not
   * merged into: it answers "Docs (1)", and every file in the batch has to be
   * re-rooted onto that answer or the tree lands in two places.
   */
  it('reserves one destination for the whole tree', async () => {
    await mountUploader();

    await pick({ directory: true }, tree());

    expect(api.reserveFolderUploadTarget).toHaveBeenCalledTimes(1);
    expect(api.reserveFolderUploadTarget).toHaveBeenCalledWith('Docs', 'Docs');
  });

  it('re-roots every file onto the name the server gave back', async () => {
    const uppy = await mountUploader();

    await pick({ directory: true }, tree());

    expect(uppy.getFiles().map((file) => file.meta.resolvedRelativePath)).toEqual([
      'Docs (1)/a.txt',
      'Docs (1)/sub/b.txt',
    ]);
  });

  it('refuses when the browser did not say what the folder was', async () => {
    const uppy = await mountUploader();

    await pick({ directory: true }, [new File(['hello'], 'a.txt')]);

    expect(uppy.getFiles()).toHaveLength(0);
    expect(lastToast().heading).toBe('Your browser did not provide the selected folder structure.');
  });

  it('refuses, with the reason, when the server would not reserve one', async () => {
    api.reserveFolderUploadTarget.mockRejectedValueOnce(new Error('Volume is full'));
    const uppy = await mountUploader();

    await pick({ directory: true }, tree());

    expect(uppy.getFiles()).toHaveLength(0);
    expect(lastToast().heading).toBe('Volume is full');
  });

  it('refuses when the server answered without a destination', async () => {
    api.reserveFolderUploadTarget.mockResolvedValueOnce({});
    const uppy = await mountUploader();

    await pick({ directory: true }, tree());

    expect(uppy.getFiles()).toHaveLength(0);
    expect(lastToast().heading).toBe('The server did not reserve a destination folder.');
  });
});

describe('dropping files onto a part of the page', () => {
  const mountDropTarget = (element) =>
    mount(
      defineComponent({
        setup: () => {
          useUppyDropTarget({ value: element });
          return {};
        },
        render: () => null,
      })
    );

  it('teaches that element to receive them', async () => {
    const uppy = await mountUploader();
    const element = document.createElement('div');

    const target = mountDropTarget(element);
    await settle();

    expect(uppy.getPlugin('DropTarget')).toBeTruthy();
    target.unmount();
  });

  it('stops when the element goes away', async () => {
    const uppy = await mountUploader();
    const element = document.createElement('div');
    const target = mountDropTarget(element);
    await settle();

    target.unmount();
    await settle();

    expect(uppy.getPlugin('DropTarget')).toBeFalsy();
  });

  it('does nothing at all when there is no element to drop onto', async () => {
    const uppy = await mountUploader();

    const target = mountDropTarget(null);
    await settle();

    expect(uppy.getPlugin('DropTarget')).toBeFalsy();
    target.unmount();
  });
});
