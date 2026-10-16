import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a folder of files costs before a single byte is sent.
 *
 * Dropping a folder of four gigabytes made the tab stop responding, and the
 * reason was not the bytes: it was what the engine did per file. Each one
 * started an operation of its own in the store — one reactive entry and one
 * drawn row, with nothing capping the list — set the resumable uploader's
 * options again, which rebuilds its translator, and wrote its state and its
 * metadata in two more updates. Four notifications to the store and a
 * translator per file, times a few thousand files.
 *
 * So this counts rather than times: a stopwatch on this machine says nothing
 * about anybody else's, while "one operation for the batch" and "the uploader
 * configured once" are properties that either hold or do not. Each count is
 * asserted against the size of the batch, so a cost that creeps back in per
 * file fails here however fast the machine running it is.
 */

const handlers = new Map();
const uppyCalls = [];

/**
 * The plugins the engine asks for, which have to exist to be measured.
 *
 * `getPlugin` answering undefined makes `getPlugin('Tus')?.setOptions?.()`
 * short-circuit, so a count of those calls stays at zero whatever the engine
 * does — an assertion that agrees with the defect. Each plugin is a recorded
 * object instead, and the same object every time, as Uppy's own is.
 */
const plugins = new Map();
const pluginFor = (id) => {
  if (!plugins.has(id)) {
    plugins.set(id, {
      name: id,
      setOptions: (...args) => uppyCalls.push([`setOptions:${id}`, ...args]),
    });
  }
  return plugins.get(id);
};

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
      getPlugin: (id) => {
        uppyCalls.push(['getPlugin', id]);
        return pluginFor(id);
      },
      // The real one always answers a list; the proxy below would answer
      // undefined, and the engine walks what it is given.
      getFiles: () => [],
      // Present, because the engine keeps a per-file road for an Uppy that does
      // not have this one — and a fake without it would measure that road.
      patchFilesState: (states) => uppyCalls.push(['patchFilesState', states]),
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
// Chunked uploads on: they are the only ones that can be resumed, which is what
// this file is about. One case turns them off, because the fallback from a
// refused direct upload is the route a large file really takes the first time.
const uploads = vi.hoisted(() => ({
  chunkedEnabled: true,
  chunkedAutoFallback: true,
  chunkSizeBytes: 8 * 1024 * 1024,
}));
vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({
    loaded: true,
    state: { uploads },
    ensureLoaded: () => Promise.resolve(),
  }),
}));
vi.mock('@/stores/volumeUsage', () => ({
  useVolumeUsageStore: () => ({ scheduleRefresh: vi.fn() }),
}));
vi.mock('@/stores/folderSize', () => ({
  useFolderSizeStore: () => ({ scheduleRefresh: vi.fn() }),
}));
const started = vi.hoisted(() => []);
const finished = vi.hoisted(() => []);
vi.mock('@/stores/operationTasks', () => ({
  useOperationTasksStore: () => ({
    startOperation: (operation) => {
      started.push(operation);
      return `op-${started.length}`;
    },
    updateOperation: vi.fn(),
    finishOperation: (id) => finished.push(id),
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

beforeEach(async () => {
  vi.useFakeTimers();
  handlers.clear();
  uppyCalls.length = 0;
  started.length = 0;
  finished.length = 0;
  localStorage.clear();
  uploads.chunkedEnabled = true;
  uploads.chunkedAutoFallback = true;
  fileStore.currentPath = 'Docs/2026';
  plugins.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A batch big enough that a per-file cost is unmistakable. */
const MANY = 200;

const aDroppedFile = (index) => ({
  name: `shot-${index}.jpg`,
  type: 'image/jpeg',
  size: 2048,
  lastModified: 1760000000000 + index,
  relativePath: `Holiday/day-${index % 7}/shot-${index}.jpg`,
});

/**
 * The batch, added and then announced file by file.
 *
 * Uppy's `addFiles` makes one state update, emits `file-added` once per file and
 * `files-added` once for the batch, so a test that only calls the add function
 * measures none of what those handlers do — and the batch one writes metadata
 * per file inside its single event.
 */
const addAndAnnounce = async (engine, files) => {
  engine.addDroppedFiles(files);
  // Announced from the descriptors the engine handed over, because that is what
  // Uppy does: a file reaching a handler carries the metadata it was described
  // with. Inventing bare files here would make the engine's fill-in paths fire
  // and count their writes against it — a test measuring its own fixture.
  const described = (called('addFiles')[0]?.[1] || []).map((descriptor, index) => ({
    id: `uppy-${index}`,
    name: descriptor.name,
    type: descriptor.type,
    size: descriptor.data?.size,
    data: descriptor.data,
    meta: descriptor.meta,
  }));
  // The order Uppy's own `addFiles` emits in: one state update, then
  // `file-added` for each, then `files-added` once for the batch.
  for (const file of described) await fire('file-added', file);
  await fire('files-added', described);
  return described;
};

describe('a folder of files', () => {
  it('is one operation, not one for every file in it', async () => {
    const engine = await createUploadEngine();
    await addAndAnnounce(
      engine,
      Array.from({ length: MANY }, (_, index) => aDroppedFile(index))
    );

    // One row for the thing the reader asked for. Before this, two hundred.
    expect(started.length).toBe(1);
    expect(started[0]).toMatchObject({ type: 'upload', itemCount: MANY });
    // And it knows how much is coming, which is what a single bar needs.
    expect(started[0].totalBytes).toBe(MANY * 2048);
  });

  it('configures the uploader once for the batch, not once per file', async () => {
    const engine = await createUploadEngine();
    const before = called('setOptions:Tus').length;
    await addAndAnnounce(
      engine,
      Array.from({ length: MANY }, (_, index) => aDroppedFile(index))
    );

    // `setOptions` writes plugin state and rebuilds the translator, so a call
    // per file is a translator per file.
    expect(called('setOptions:Tus').length - before).toBeLessThan(3);
  });

  it('writes one thing per file afterwards, not four', async () => {
    const engine = await createUploadEngine();
    await addAndAnnounce(
      engine,
      Array.from({ length: MANY }, (_, index) => aDroppedFile(index))
    );

    // The metadata is in the descriptor the file was added with, so none of it
    // has to be written again once Uppy holds the file.
    expect(called('setFileMeta').length).toBe(0);
    // The address cannot be: Uppy builds a file from a fixed shape and drops
    // the keys it does not know, so `tus` has to be written afterwards — once
    // for the whole slice. Writing it per file copies Uppy's entire file map
    // every time, which is 17 seconds at eight thousand files against 13
    // milliseconds for one call.
    expect(called('setFileState').length).toBe(0);
    expect(called('patchFilesState').length).toBe(1);
    const [[, states]] = called('patchFilesState');
    expect(Object.keys(states)).toHaveLength(MANY);
    expect(Object.values(states).every((state) => state?.tus?.endpoint)).toBe(true);
  });

  it('adds the files the picker chose in one call', async () => {
    const engine = await createUploadEngine();
    engine.addPickedFiles(
      Array.from({ length: MANY }, (_, index) => {
        const file = aDroppedFile(index);
        return { name: file.name, type: file.type, data: file, meta: {} };
      })
    );

    // The dropped path has always batched; the picker added them one at a time,
    // and one `addFile` is one state update.
    expect(called('addFile').length).toBe(0);
    expect(called('addFiles').length).toBe(1);
    expect(called('addFiles')[0][1]).toHaveLength(MANY);
  });
});

describe('letting a batch go', () => {
  /**
   * Cancelling one was as expensive as adding it.
   *
   * `removeFile` goes through `removeFiles([id])`, which copies the whole file
   * map and the whole uploads map on every call — so taking a batch of
   * thousands back one file at a time is quadratic, and froze the tab exactly
   * as adding them used to. Reported from a real drop: the files appeared, the
   * cancel was pressed, and the tab stopped answering again.
   */
  it('stops the whole job in one call, not one call per file', async () => {
    const engine = await createUploadEngine();
    await addAndAnnounce(
      engine,
      Array.from({ length: MANY }, (_, index) => aDroppedFile(index))
    );

    started[0].cancel();

    // Not one `removeFile` per file, which copies every file's state each time.
    expect(called('removeFile')).toHaveLength(0);
    // And not `removeFiles` either, which takes the files back and leaves the
    // upload run standing — whatever was left in it carried on, and the
    // fallback then added the rest again under a new run that reserved the next
    // folder name. `cancelAll` clears the run with the files.
    expect(called('cancelAll')).toHaveLength(1);
    // The row goes, rather than being left behind with nothing under it.
    expect(finished).toContain('op-1');
  });

  it('is held in one call while it is the only one in flight', async () => {
    const engine = await createUploadEngine();
    await addAndAnnounce(
      engine,
      Array.from({ length: MANY }, (_, index) => aDroppedFile(index))
    );

    started[0].pause();
    started[0].resume();

    // `pauseResume` writes one file's state, which copies every file's: a loop
    // over the batch is the same quadratic cost under another name.
    expect(called('pauseResume')).toHaveLength(0);
    expect(called('pauseAll')).toHaveLength(1);
    expect(called('resumeAll')).toHaveLength(1);
  });
});

describe('a batch the reader called off', () => {
  /**
   * An abort is not a failure, and reading it as one started the upload again.
   *
   * Cancelling aborts the requests in flight, and an aborted request reaches
   * `upload-error` looking exactly like a proxy refusing an over-sized body. So
   * the fallback took the remaining files and added them again as chunks: the
   * upload carried on under a new run, and the folder reserved for the first
   * had already been released, so the new run reserved the next name. Reported
   * from a real drop as `ardoise`, `ardoise (1)`, `ardoise (2)`, `ardoise (3)`.
   */
  const aLargeFile = {
    id: 'uppy-0',
    name: 'target.rlib',
    size: 2 * 1024 * 1024 * 1024,
    progress: {},
    data: { name: 'target.rlib', size: 2 * 1024 * 1024 * 1024, lastModified: 1760000000000 },
    meta: { relativePath: 'ardoise/target.rlib', uploadTo: 'Docs/2026' },
  };

  /** The mode the fallback lives in: direct, with chunks allowed after a refusal. */
  const withFallback = async () => {
    uploads.chunkedEnabled = false;
    uploads.chunkedAutoFallback = true;
    return createUploadEngine();
  };

  it('does not take a refused upload as a reason to start again', async () => {
    const engine = await withFallback();
    engine.addDroppedFiles([
      { name: aLargeFile.name, size: aLargeFile.size, relativePath: 'ardoise/target.rlib' },
    ]);
    await fire('file-added', aLargeFile);
    await fire('files-added', [aLargeFile]);

    started[0].cancel();
    // The abort arrives after the files have been taken back, as it does.
    await fire('upload-error', aLargeFile, new Error('aborted'), { status: 413 });
    // The re-add is scheduled rather than immediate, so the clock has to move.
    await vi.advanceTimersByTimeAsync(10);

    expect(called('addFile')).toHaveLength(0);
  });

  it('still falls back for an upload that was actually refused', async () => {
    const engine = await withFallback();
    engine.addDroppedFiles([
      { name: aLargeFile.name, size: aLargeFile.size, relativePath: 'ardoise/target.rlib' },
    ]);
    await fire('file-added', aLargeFile);
    await fire('files-added', [aLargeFile]);

    // Nothing was cancelled: the same error is the one the fallback exists for.
    await fire('upload-error', aLargeFile, new Error('too large'), { status: 413 });
    await vi.advanceTimersByTimeAsync(10);

    expect(called('addFile')).toHaveLength(1);
  });
});
