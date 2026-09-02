import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The folder-size index hooks, and the promise made in their own header:
 * "an indexing hiccup can never fail (or slow down materially) the user's
 * actual file operation".
 *
 * That promise is the design. Every hook runs inside an upload, a delete, a
 * move — operations that must succeed whether or not a size index is healthy,
 * enabled, or present at all. A throw escaping any of them turns bookkeeping
 * into a failed file operation, and a size index is exactly the thing that is
 * broken on somebody's NAS at 3am.
 *
 * Run against the real index and a real database rather than mocks, because the
 * first attempt at this file mocked the config module, the mock silently did not
 * apply, the feature was off for every test, and thirty-four assertions passed
 * against a no-op. The switch is asserted before anything else for that reason.
 */

let ctx;

const setup = async ({ mode = 'full', exclude } = {}) => {
  const env = await setupTestEnv({
    tag: 'folder-size-hooks-',
    modules: [
      'src/config/env',
      'src/config/index',
      'src/services/db',
      'src/services/folderSizeIndex',
      'src/services/folderSizeIndexer',
      'src/services/folderSizeManager',
      'src/services/folderSizeHooks',
    ],
    env: { FOLDER_SIZE_MODE: mode, ...(exclude ? { FOLDER_SIZE_EXCLUDE_PATHS: exclude } : {}) },
  });
  const { getDb } = env.requireFresh('src/services/db');
  const index = env.requireFresh('src/services/folderSizeIndex');
  const hooks = env.requireFresh('src/services/folderSizeHooks');
  const db = await getDb();
  ctx = { env, db, index, hooks, volume: env.volumeDir };
  return ctx;
};

afterEach(async () => {
  if (ctx) {
    await ctx.env.cleanup();
    ctx = null;
  }
});

const sizeOf = (absolutePath) => {
  const row = ctx.index.getByAbsolutePath(ctx.db, absolutePath);
  return row ? row.sizeBytes : null;
};

const seedFolder = async (relative) => {
  const absolute = path.join(ctx.volume, relative);
  await fs.mkdir(absolute, { recursive: true });
  await ctx.hooks.onFolderCreated(absolute);
  return absolute;
};

/** Every hook, with arguments that make sense for it. */
const everyHook = (root) => [
  ['onFileWritten', (h) => h.onFileWritten(path.join(root, 'a.txt'), 1024)],
  ['onFileReplaced', (h) => h.onFileReplaced(path.join(root, 'a.txt'), 512, 1024)],
  ['onFolderCreated', (h) => h.onFolderCreated(path.join(root, 'sub'))],
  ['onEntryDeleted (file)', (h) => h.onEntryDeleted(path.join(root, 'a.txt'), { size: 1024 })],
  [
    'onEntryDeleted (dir)',
    (h) => h.onEntryDeleted(path.join(root, 'sub'), { isDirectory: true }),
  ],
  ['beginDirectoryTransfer', (h) => h.beginDirectoryTransfer(path.join(root, 'sub'))],
  ['cancelDirectoryTransfer', (h) => h.cancelDirectoryTransfer(path.join(root, 'sub'))],
  [
    'onEntryMoved',
    (h) => h.onEntryMoved(path.join(root, 'a.txt'), path.join(root, 'b.txt'), { size: 1024 }),
  ],
  ['onEntryCopied', (h) => h.onEntryCopied(path.join(root, 'b.txt'), { size: 1024 })],
  ['refreshTransferredDirectories', (h) => h.refreshTransferredDirectories([path.join(root, 'sub')])],
  [
    'onEntryRenamed',
    (h) => h.onEntryRenamed(path.join(root, 'a.txt'), path.join(root, 'c.txt')),
  ],
];

describe('the switch these tests depend on', () => {
  it('is on, so everything below exercises something', async () => {
    const { hooks: h, volume } = await setup();
    const folder = path.join(volume, 'Docs');
    await fs.mkdir(folder, { recursive: true });

    await h.onFolderCreated(folder);

    expect(sizeOf(folder)).toBe(0);
  });

  it('is off in "off" mode, and then nothing is written', async () => {
    const { hooks: h, volume } = await setup({ mode: 'off' });
    const folder = path.join(volume, 'Docs');
    await fs.mkdir(folder, { recursive: true });

    await h.onFolderCreated(folder);

    expect(sizeOf(folder)).toBeNull();
  });
});

describe('the deltas they apply', () => {
  it('adds a written file’s bytes to its parent', async () => {
    const { hooks: h } = await setup();
    const docs = await seedFolder('Docs');

    await h.onFileWritten(path.join(docs, 'report.txt'), 1024);

    expect(sizeOf(docs)).toBe(1024);
  });

  it('adds up several writes', async () => {
    const { hooks: h } = await setup();
    const docs = await seedFolder('Docs');

    await h.onFileWritten(path.join(docs, 'a.txt'), 1000);
    await h.onFileWritten(path.join(docs, 'b.txt'), 500);

    expect(sizeOf(docs)).toBe(1500);
  });

  /** Replacing changes bytes, and only the difference. */
  it('applies the difference when a file is replaced', async () => {
    const { hooks: h } = await setup();
    const docs = await seedFolder('Docs');
    await h.onFileWritten(path.join(docs, 'a.txt'), 400);

    await h.onFileReplaced(path.join(docs, 'a.txt'), 400, 1000);

    expect(sizeOf(docs)).toBe(1000);
  });

  it('shrinks the parent when the replacement is smaller', async () => {
    const { hooks: h } = await setup();
    const docs = await seedFolder('Docs');
    await h.onFileWritten(path.join(docs, 'a.txt'), 1000);

    await h.onFileReplaced(path.join(docs, 'a.txt'), 1000, 400);

    expect(sizeOf(docs)).toBe(400);
  });

  it('subtracts a deleted file’s bytes', async () => {
    const { hooks: h } = await setup();
    const docs = await seedFolder('Docs');
    await h.onFileWritten(path.join(docs, 'a.txt'), 2048);

    await h.onEntryDeleted(path.join(docs, 'a.txt'), { size: 2048 });

    expect(sizeOf(docs)).toBe(0);
  });

  /** The propagation is the point: a size is only useful if ancestors know. */
  it('carries a write all the way up the ancestors', async () => {
    const { hooks: h } = await setup();
    const docs = await seedFolder('Docs');
    const year = await seedFolder('Docs/2026');

    await h.onFileWritten(path.join(year, 'q1.txt'), 4096);

    expect(sizeOf(year)).toBe(4096);
    expect(sizeOf(docs)).toBe(4096);
  });

  /**
   * A deleted directory's size is not passed in — it comes from the index,
   * because only the index knows what its subtree came to.
   */
  it('takes a deleted directory’s size from the index and removes it from the parent', async () => {
    const { hooks: h } = await setup();
    const docs = await seedFolder('Docs');
    const year = await seedFolder('Docs/2026');
    await h.onFileWritten(path.join(year, 'q1.txt'), 4096);

    await h.onEntryDeleted(year, { isDirectory: true });

    expect(sizeOf(docs)).toBe(0);
    expect(sizeOf(year)).toBeNull();
  });

  it('treats a missing size as zero rather than NaN', async () => {
    const { hooks: h } = await setup();
    const docs = await seedFolder('Docs');

    await h.onFileWritten(path.join(docs, 'a.txt'), undefined);

    expect(sizeOf(docs)).toBe(0);
  });

  it('records a new folder as empty', async () => {
    const { hooks: h } = await setup();
    const docs = await seedFolder('Docs');

    const sub = path.join(docs, 'sub');
    await fs.mkdir(sub);
    await h.onFolderCreated(sub);

    expect(sizeOf(sub)).toBe(0);
  });
});

describe('paths the operator excluded', () => {
  it('are left out of the index entirely', async () => {
    const { hooks: h, volume } = await setup({ exclude: 'Stacks' });
    const stacks = path.join(volume, 'Stacks');
    await fs.mkdir(stacks, { recursive: true });

    await h.onFolderCreated(stacks);
    await h.onFileWritten(path.join(stacks, 'huge.img'), 999_999);

    expect(sizeOf(stacks)).toBeNull();
  });
});

describe('nothing they do can fail the operation they run inside', () => {
  /**
   * The index itself throwing on every call is the shape of a corrupt or
   * locked database, which is the case that reaches people and the case no
   * other test covers.
   */
  it.each(everyHook('/volumes/Docs').map(([name]) => name))(
    '%s survives the index throwing',
    async (name) => {
      const { hooks: h, index, volume } = await setup();
      const docs = await seedFolder('Docs');
      for (const key of Object.keys(index)) {
        if (typeof index[key] === 'function') {
          vi.spyOn(index, key).mockImplementation(() => {
            throw new Error('index corrupt');
          });
        }
      }

      const call = everyHook(docs).find(([hookName]) => hookName === name)[1];
      await expect(Promise.resolve(call(h))).resolves.not.toThrow();
      expect(volume).toBeTruthy();
      vi.restoreAllMocks();
    }
  );

  it.each(everyHook('/volumes/Docs').map(([name]) => name))(
    '%s does nothing and throws nothing when the feature is off',
    async (name) => {
      const { hooks: h, volume } = await setup({ mode: 'off' });
      const docs = path.join(volume, 'Docs');
      await fs.mkdir(docs, { recursive: true });

      const call = everyHook(docs).find(([hookName]) => hookName === name)[1];
      await expect(Promise.resolve(call(h))).resolves.not.toThrow();
      expect(sizeOf(docs)).toBeNull();
    }
  );
});
