import { afterEach, describe, expect, it, vi } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A picked folder reaches the server as one request per file, dozens of them
 * in flight at once. The folder they belong to is decided by whichever of them
 * arrives first; every other one has to be told the same answer, and a second
 * upload of the same folder has to be told a different one.
 *
 * Getting it wrong loses nothing on disk, which is why it would go unnoticed:
 * a folder of photos comes back scattered over `photos (1)`, `photos (2)` and
 * `photos (3)`, or two uploads of it are poured into one folder where the
 * copies of each file sit side by side under numbered names. Both only show up
 * under concurrency, which the sequential suite beside this one never has.
 */

let envContext;
let service;

const build = async () => {
  envContext = await setupTestEnv({ tag: 'folder-upload-batches-' });
  service = envContext.requireFresh('src/services/uploadFolderTargetService');
  const destinationRoot = path.join(envContext.volumeDir, 'Inbox');
  await fs.mkdir(destinationRoot, { recursive: true });
  return destinationRoot;
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const OWNER = { user: { id: 'owner' } };

/**
 * Two roads to the same folder, and they could not see each other.
 *
 * The browser asks for the folder once for the whole batch, before a byte is
 * sent, and then writes the resolved path onto every file. A file that arrives
 * without that resolved path is resolved here instead — and this side kept its
 * own record, which the batch's own reservation never wrote to. So a file of a
 * batch that already had a folder was given a second one.
 *
 * Every file of a cancelled batch is such a file: the browser stops resolving
 * the moment the reader presses stop, but a run already on its way still sends
 * what it holds. Reported as a drop that answered `ardoise`, and then `ardoise
 * (1)` for the files that went out after the press — with one `folder-session`
 * call in the log, so the second folder came from here.
 */
describe('a file of a batch that already reserved its folder', () => {
  it('lands in that folder rather than reserving another', async () => {
    const destinationRoot = await build();

    // What the browser asks for once, before sending anything.
    const targetRoot = await service.reserveFolderUploadTarget({
      destinationRoot,
      logicalBase: 'Inbox',
      sourceRoot: 'ardoise',
      context: OWNER,
      uploadBatchId: 'batch-reserved-01',
    });
    expect(targetRoot).toBe('ardoise');

    // And a file of that same batch, arriving without the resolved path.
    const landed = await service.resolveFolderUploadRelativePath({
      relativePath: 'ardoise/note.txt',
      destinationRoot,
      logicalBase: 'Inbox',
      context: OWNER,
      uploadBatchId: 'batch-reserved-01',
    });

    expect(landed).toBe('ardoise/note.txt');
    expect(await fs.readdir(destinationRoot)).toEqual(['ardoise']);
  });

  /**
   * And a batch nobody reserved for still gets its own folder: the road for a
   * client that does not ask first has not changed.
   */
  it('still reserves for a batch that never asked', async () => {
    const destinationRoot = await build();
    await fs.mkdir(path.join(destinationRoot, 'ardoise'));

    const landed = await service.resolveFolderUploadRelativePath({
      relativePath: 'ardoise/note.txt',
      destinationRoot,
      logicalBase: 'Inbox',
      context: OWNER,
      uploadBatchId: 'batch-unasked-01',
    });

    expect(landed).toBe('ardoise (1)/note.txt');
  });

  /**
   * The record is the asker's own. A batch id is the browser's to choose, so
   * one reader must never be able to aim their files at a folder reserved
   * under somebody else's name by guessing it.
   */
  it('is not shared with another reader who names the same batch', async () => {
    const destinationRoot = await build();
    await service.reserveFolderUploadTarget({
      destinationRoot,
      logicalBase: 'Inbox',
      sourceRoot: 'ardoise',
      context: OWNER,
      uploadBatchId: 'batch-guessed-01',
    });

    const landed = await service.resolveFolderUploadRelativePath({
      relativePath: 'ardoise/note.txt',
      destinationRoot,
      logicalBase: 'Inbox',
      context: { user: { id: 'somebody-else' } },
      uploadBatchId: 'batch-guessed-01',
    });

    expect(landed).toBe('ardoise (1)/note.txt');
  });
});

describe('the files of one folder upload, arriving together', () => {
  it('all land in the one folder the first of them reserved', async () => {
    const destinationRoot = await build();
    await fs.mkdir(path.join(destinationRoot, 'photos'));

    const files = ['a.jpg', 'b.jpg', 'c.jpg', '2026/d.jpg', '2026/e.jpg', 'f.jpg'];
    const landed = await Promise.all(
      files.map((file) =>
        service.resolveFolderUploadRelativePath({
          relativePath: `photos/${file}`,
          destinationRoot,
          logicalBase: 'Inbox',
          context: OWNER,
          uploadBatchId: 'batch-together-01',
        })
      )
    );

    expect(landed).toEqual(files.map((file) => `photos (1)/${file}`));
    // One folder reserved, not one per file that raced for it.
    expect((await fs.readdir(destinationRoot)).sort()).toEqual(['photos', 'photos (1)']);
  });
});

describe('two uploads of the same folder, started at the same time', () => {
  it('are kept in separate folders rather than merged into one', async () => {
    const destinationRoot = await build();

    const [first, second] = await Promise.all([
      service.resolveFolderUploadRelativePath({
        relativePath: 'photos/a.jpg',
        destinationRoot,
        logicalBase: 'Inbox',
        context: OWNER,
        uploadBatchId: 'batch-first-0001',
      }),
      service.resolveFolderUploadRelativePath({
        relativePath: 'photos/a.jpg',
        destinationRoot,
        logicalBase: 'Inbox',
        context: OWNER,
        uploadBatchId: 'batch-second-001',
      }),
    ]);

    expect([first, second].sort()).toEqual(['photos (1)/a.jpg', 'photos/a.jpg']);
  });
});

describe('a folder arriving under the name an upload chose', () => {
  /**
   * The name was looked for first and created afterwards, with a recursive
   * mkdir that succeeds on a folder already there: whatever arrived under it in
   * between — another upload, a copy, a folder made over SMB — received this
   * upload's files. These make it arrive just before that mkdir.
   */
  const arriveJustBefore = (target, arrive) => {
    const mkdir = fs.mkdir.bind(fs);
    let arrived = false;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (candidate, options) => {
      if (!arrived && candidate === target) {
        arrived = true;
        arrive();
      }
      return mkdir(candidate, options);
    });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is never poured into, and the upload takes the next name', async () => {
    const destinationRoot = await build();
    const theirs = path.join(destinationRoot, 'photos');
    arriveJustBefore(theirs, () => {
      fsSync.mkdirSync(theirs);
      fsSync.writeFileSync(path.join(theirs, 'theirs.jpg'), 'theirs');
    });

    const landed = await service.resolveFolderUploadRelativePath({
      relativePath: 'photos/a.jpg',
      destinationRoot,
      logicalBase: 'Inbox',
      context: OWNER,
      uploadBatchId: 'batch-arriving-01',
    });

    expect(landed).toBe('photos (1)/a.jpg');
    expect(await fs.readdir(theirs)).toEqual(['theirs.jpg']);
    expect((await fs.readdir(destinationRoot)).sort()).toEqual(['photos', 'photos (1)']);
  });

  it('takes the next name even when what arrived is empty', async () => {
    const destinationRoot = await build();
    const theirs = path.join(destinationRoot, 'photos');
    arriveJustBefore(theirs, () => fsSync.mkdirSync(theirs));

    const landed = await service.resolveFolderUploadRelativePath({
      relativePath: 'photos/a.jpg',
      destinationRoot,
      logicalBase: 'Inbox',
      context: OWNER,
      uploadBatchId: 'batch-arriving-02',
    });

    expect(landed).toBe('photos (1)/a.jpg');
  });

  it('still creates the destination itself when it is not there yet', async () => {
    const destinationRoot = path.join(await build(), 'not yet made');

    const landed = await service.resolveFolderUploadRelativePath({
      relativePath: 'photos/a.jpg',
      destinationRoot,
      logicalBase: 'Inbox/not yet made',
      context: OWNER,
      uploadBatchId: 'batch-new-root-01',
    });

    expect(landed).toBe('photos/a.jpg');
    expect(await fs.readdir(destinationRoot)).toEqual(['photos']);
  });
});

describe('reserving a folder where none can be made', () => {
  /**
   * Only a name already taken is worth trying the next number for. Anything
   * else — a destination that has gone, a disk mounted read-only — fails the
   * same way for every number, and treating it as a collision spent a hundred
   * thousand attempts before answering with a reason that named the wrong
   * problem.
   */
  it('gives up at once with the real reason', async () => {
    const destinationRoot = await build();
    const missing = path.join(destinationRoot, 'unmounted');

    await expect(
      service.reserveFolderUploadTarget({
        destinationRoot: missing,
        logicalBase: 'Inbox/unmounted',
        sourceRoot: 'photos',
        context: OWNER,
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
