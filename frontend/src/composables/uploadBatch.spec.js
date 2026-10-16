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
/** The files the fake uploader is holding, by id. */
const held = new Map();

/**
 * One order of events for the uploader and the operations store together.
 *
 * Each has a record of its own, and nothing in either says which came first —
 * which is the whole question for a cancel: stopping the uploader after a loop
 * over every file of the batch left it sending throughout that loop.
 */
const timeline = [];

/**
 * Whether the fake announces the files it is given, the way Uppy does.
 *
 * Uppy emits `file-added` and `files-added` from inside `addFiles`, before the
 * call returns. Most cases here want to announce by hand — they craft the file
 * a handler sees, to measure what the engine writes for it — so this is off by
 * default. It has to be on for anything that measures what happens *between*
 * two slices of one drop: with the announcement arriving late instead, the
 * batch looks empty in the gap and the engine is measured closing a batch no
 * reader ever finished.
 */
const announcesOnAdd = { on: false };

/** The files the fake announced, in the order it announced them. */
const announced = [];

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
      getFiles: () => [...held.values()],
      // And it keeps the files it was given, so the step that reserves a folder
      // can be reached at all: asking an uploader that answers `undefined` for
      // every file is asking nothing.
      getFile: (id) => held.get(id),
      // Present, because the engine keeps a per-file road for an Uppy that does
      // not have this one — and a fake without it would measure that road.
      patchFilesState: (states) => uppyCalls.push(['patchFilesState', states]),
    },
    {
      get: (target, property) => {
        if (property in target) return target[property];
        return (...args) => {
          uppyCalls.push([String(property), ...args]);
          timeline.push(`uppy:${String(property)}`);
          if (property === 'addFiles') {
            // Numbered from where the last call stopped, which `held.size` on
            // its own was not: it grows as the loop sets each file, so a slice
            // of four was kept as uppy-0, uppy-2, uppy-4, uppy-6 and half the
            // ids a test asked for answered undefined.
            const base = held.size;
            const added = (args[0] || []).map((descriptor, index) => {
              const id = `uppy-${base + index}`;
              const file = { id, ...descriptor, size: descriptor.data?.size };
              held.set(id, file);
              return file;
            });
            if (announcesOnAdd.on) {
              announced.push(...added);
              added.forEach((file) =>
                (handlers.get('file-added') || []).forEach((handler) => handler(file))
              );
              (handlers.get('files-added') || []).forEach((handler) => handler(added));
            }
          }
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
    finishOperation: (id) => {
      finished.push(id);
      timeline.push(`finish:${id}`);
    },
  }),
}));

vi.mock('@/api', () => ({
  apiBase: '',
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
  reserveFolderUploadTarget: vi.fn(() => Promise.resolve({ targetRoot: 'Holiday' })),
}));

import * as api from '@/api';
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
  held.clear();
  announcesOnAdd.on = false;
  announced.length = 0;
  timeline.length = 0;
  // The reservation is a module-level mock, so its calls outlive the case that
  // made them: a count asserted without this one reads every case before it in
  // the file and says two where the engine asked once.
  api.reserveFolderUploadTarget.mockClear();
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

    /**
     * And the uploader was stopped before any of that.
     *
     * The bookkeeping is a loop over every file of the batch — two hundred
     * here, thousands on the drop this matters for — and the uploader used to
     * keep going throughout it. A run that entered the pre-processor during
     * that loop found its batch cancelled, so it did not resolve where its
     * files were going, and was not stopped either: it sent them unresolved,
     * and the server gave them a folder of their own.
     */
    expect(timeline.indexOf('uppy:cancelAll')).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf('uppy:cancelAll')).toBeLessThan(timeline.indexOf('finish:op-1'));
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

describe('cancelling while the drop is still being handed over', () => {
  /**
   * The slices have to obey too, and this is where the folders came from.
   *
   * A drop is handed to the uploader in slices with the main thread given back
   * between them, so a reader watching a count climb and pressing stop lands in
   * the middle of that loop. The files already added stopped; the loop kept
   * feeding the rest, and each later slice found its batch closed and opened
   * another — which reserved the next folder name. Reported as `ardoise`,
   * `ardoise (1)`, `ardoise (2)` seconds apart, which is the rhythm of a slice
   * and not of a retry.
   */
  const SLICES = 3;

  it('hands over nothing more once it has been cancelled', async () => {
    const engine = await createUploadEngine();
    const files = Array.from({ length: 250 * SLICES }, (_, index) => aDroppedFile(index));

    const adding = engine.addDroppedFiles(files);

    // The first slice goes inside the call itself, before anything is awaited.
    expect(called('addFiles')).toHaveLength(1);
    const handed = (called('addFiles')[0][1] || []).map((descriptor, index) => ({
      id: `uppy-${index}`,
      name: descriptor.name,
      size: descriptor.data?.size,
      data: descriptor.data,
      meta: descriptor.meta,
    }));
    for (const file of handed) await fire('file-added', file);
    await fire('files-added', handed);
    expect(started).toHaveLength(1);

    started[0].cancel();
    await vi.advanceTimersByTimeAsync(100);
    await adding;

    // The slices that had not been handed over are never handed over...
    expect(called('addFiles')).toHaveLength(1);
    // ...so no second batch opens behind the reader's back, which is what
    // reserved a second folder.
    expect(started).toHaveLength(1);
    // And the run is cleared, not merely emptied. A batch still being handed
    // over is kept in the register until the hand-over stops, so a cancel that
    // asks "is anything else in flight?" by counting the register finds its own
    // entry and answers yes — taking the `removeFiles` road, which hands the
    // files back and leaves the run standing. Cancelling in the middle of the
    // hand-over is the one moment a reader actually does this.
    expect(called('cancelAll')).toHaveLength(1);
    expect(called('removeFiles')).toHaveLength(0);
  });

  /**
   * And it stays cancelled when the uploader reports the run it just stopped.
   *
   * Stopping the uploader ends the run it was in the middle of, and Uppy says
   * so: `cancelAll` leaves a `complete` behind it. The engine's handler for
   * that event cleared the watchdog's bookkeeping — and the record of what the
   * reader had called off was kept in the same place, with a different life.
   * So the press added the batch to it, stopped the uploader, and the run
   * ending wiped it: the hand-over loop asked whether its batch had been
   * called off, was told no, and fed the uploader the remaining eight thousand
   * files. The batch re-opened, the uploads started again, and the
   * pre-processor turned nothing away, so what went out after the press was
   * given folders of its own. Measured in a real browser at ten thousand
   * files: the slices kept going at 2500, 5000 and 7500, each reading its own
   * batch as not cancelled.
   */
  it('stays cancelled when the uploader reports the run it stopped', async () => {
    const engine = await createUploadEngine();
    const files = Array.from({ length: 250 * SLICES }, (_, index) => aDroppedFile(index));

    const adding = engine.addDroppedFiles(files);
    const handed = (called('addFiles')[0][1] || []).map((descriptor, index) => ({
      id: `uppy-${index}`,
      name: descriptor.name,
      size: descriptor.data?.size,
      data: descriptor.data,
      meta: descriptor.meta,
    }));
    for (const file of handed) await fire('file-added', file);
    await fire('files-added', handed);

    started[0].cancel();
    // What `cancelAll` leaves behind it: the run it stopped, reported over.
    await fire('complete', { successful: [], failed: [] });
    await vi.advanceTimersByTimeAsync(100);
    await adding;

    // Still nothing more handed over, and the row still goes.
    expect(called('addFiles')).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(finished).toContain('op-1');
  });

  /**
   * And the row goes, at the scale a reader actually drops.
   *
   * Ten thousand items is forty slices, and handing over the last of them takes
   * seconds: a reader who presses stop lands in the middle of that, with most
   * of the drop not yet given to the uploader. The batch is held open while
   * slices are still coming — closing it between two of them is what made the
   * next slice reserve another folder — so the press alone cannot close it, and
   * what finishes the row is the hand-over stopping. Reported as a panel
   * reading "Téléversement de 9997 éléments" that stayed.
   */
  it('finishes the row when the press lands in the middle of the hand-over', async () => {
    const engine = await createUploadEngine();
    const files = Array.from({ length: 10_000 }, (_, index) => aDroppedFile(index));

    const adding = engine.addDroppedFiles(files);
    const handed = (called('addFiles')[0][1] || []).map((descriptor, index) => ({
      id: `uppy-${index}`,
      name: descriptor.name,
      size: descriptor.data?.size,
      data: descriptor.data,
      meta: descriptor.meta,
    }));
    for (const file of handed) await fire('file-added', file);
    await fire('files-added', handed);
    expect(started).toHaveLength(1);

    started[0].cancel();
    await vi.advanceTimersByTimeAsync(1000);
    await adding;

    // Gone, rather than left saying it is cancelling for the rest of the
    // session — and the slices that had not gone out never did.
    expect(finished).toContain('op-1');
    expect(called('addFiles').length).toBeLessThan(40);
  });
});

describe('the one place that creates a folder', () => {
  /**
   * Nothing is reserved for a batch the reader called off.
   *
   * Reserving is reached from a pre-processor, which runs once per upload run —
   * and a drop handed over in slices makes one run per slice. Cancelling empties
   * the reservations so that a later drop starts clean, and every run already in
   * flight then reserved its own: a reader who pressed stop was left with
   * fifteen folders inside one second, every one of them empty, on top of the
   * two that had anything in them.
   *
   * The check is at the moment of asking the server, not at the moment of
   * grouping the files: a run entered before the stop had already passed that
   * one, and everything after it is awaited.
   */
  const aFolderFile = (index) => ({
    name: `shot-${index}.jpg`,
    size: 2048,
    relativePath: `Holiday/shot-${index}.jpg`,
  });

  /** The pre-processor the engine installed, as Uppy would call it. */
  const preProcessor = () => called('addPreProcessor')[0]?.[1];

  it('reserves nothing once the batch has been cancelled', async () => {
    const engine = await createUploadEngine();
    await addAndAnnounce(
      engine,
      Array.from({ length: 4 }, (_, index) => aFolderFile(index))
    );
    api.reserveFolderUploadTarget.mockClear();

    started[0].cancel();
    // The run was already under way when stop was pressed, which is the case
    // that made the folders.
    await preProcessor()([...held.keys()]);

    expect(api.reserveFolderUploadTarget).not.toHaveBeenCalled();
  });

  it('still reserves one for a batch nobody cancelled', async () => {
    const engine = await createUploadEngine();
    await addAndAnnounce(
      engine,
      Array.from({ length: 4 }, (_, index) => aFolderFile(index))
    );
    api.reserveFolderUploadTarget.mockClear();

    await preProcessor()([...held.keys()]);

    // One for the batch, not one per file — the other way this goes wrong.
    expect(api.reserveFolderUploadTarget).toHaveBeenCalledTimes(1);
  });
});

describe('the takeover that made cancelling endless', () => {
  /**
   * Reported as: cancel, and another upload takes over at once; cancel that,
   * and another takes over. Twenty-six folders, one every second or two, each
   * one because the previous name was taken.
   *
   * The fallback re-adds a file that was refused, and Uppy gives the copy a new
   * id — so a guard that remembers cancelled *files* is remembering something
   * that no longer exists. The copy was never cancelled, so it uploaded,
   * stalled, was re-added, and the loop had no end. What survives a re-add is
   * the batch the file belongs to, and that is what is asked now.
   */
  it('refuses to take over for a batch that was called off, under any new id', async () => {
    uploads.chunkedEnabled = false;
    uploads.chunkedAutoFallback = true;
    const engine = await createUploadEngine();

    engine.addDroppedFiles([
      { name: 'target.rlib', size: 2 * 1024 * 1024 * 1024, relativePath: 'ardoise/target.rlib' },
    ]);
    const [descriptor] = called('addFiles')[0][1];
    const original = {
      id: 'uppy-0',
      name: descriptor.name,
      size: descriptor.data?.size,
      progress: {},
      data: descriptor.data,
      meta: descriptor.meta,
    };
    await fire('file-added', original);
    await fire('files-added', [original]);

    started[0].cancel();
    called('addFile').length = 0;

    // The copy the fallback had already made: a different id, the same batch.
    const copy = { ...original, id: 'uppy-99-restarted' };
    await fire('upload-error', copy, new Error('too large'), { status: 413 });
    await vi.advanceTimersByTimeAsync(10);

    // Nothing takes over, so nothing starts an upload run, so no folder is
    // reserved and no name is taken.
    expect(called('addFile')).toHaveLength(0);
  });
});

describe('the folders that appeared without anybody cancelling', () => {
  /**
   * One drop, one folder — however many runs it takes to hand it over.
   *
   * Handing a drop over in slices makes one upload run per slice, and the
   * reservation was released when a run finished. So the second slice asked for
   * a folder again, found the name it had just taken occupied, and was given the
   * next one. Reported as twenty-eight `folder-session` calls and twenty-eight
   * folders for one drop of two thousand two hundred files, the last of them
   * answering `ardoise (15)` — with nobody having cancelled anything. The stack
   * behind each call named the slicing loop.
   */

  it('reserves one folder however many runs it takes to hand the drop over', async () => {
    announcesOnAdd.on = true;
    const engine = await createUploadEngine();
    const files = Array.from({ length: 250 * 3 }, (_, index) => aDroppedFile(index));

    const adding = engine.addDroppedFiles(files);
    const preProcess = called('addPreProcessor')[0][1];

    // A run per slice, each one asking where to put what it was given — which
    // is what the uploader does on its own, once per `addFiles`.
    // A run per slice, each one asking where to put what it was given — which
    // is what the uploader does on its own, once per `addFiles`. The clock is
    // moved until the hand-over is over rather than a fixed number of times,
    // so the case measures the whole drop and not the first two slices of it.
    let slices = 0;
    let handingOver = true;
    adding.then(() => {
      handingOver = false;
    });
    // Until every slice has been handed over *and* every run it started has
    // been pre-processed: one advance of the clock can drain several slices, so
    // stopping as soon as the hand-over ends measures the first of them only.
    for (let step = 0; step < 50 && (handingOver || called('addFiles').length > slices); step++) {
      while (called('addFiles').length > slices) {
        const slice = called('addFiles')[slices][1];
        slices += 1;
        const sent = announced.splice(0, slice.length);
        await preProcess(sent.map((file) => file.id));
        // And the run ends, as a run does: its files are up while the slices
        // behind it are still being handed over. This is the moment the folder
        // used to be let go of.
        await fire('complete', { successful: sent, failed: [] });
      }
      if (handingOver) await vi.advanceTimersByTimeAsync(1);
    }
    await adding;

    expect(slices).toBeGreaterThan(1);
    expect(api.reserveFolderUploadTarget).toHaveBeenCalledTimes(1);
    // And the batch is named in the asking, which is what lets the server put a
    // file that arrives unresolved into the folder this reserved rather than
    // reserving a second one for it.
    const [, , askedFor] = api.reserveFolderUploadTarget.mock.calls[0];
    expect(askedFor).toBe([...held.values()][0]?.meta?.uploadBatchId);
    expect(askedFor).toEqual(expect.stringMatching(/.+/));
  });
});
