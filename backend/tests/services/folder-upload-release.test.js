import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The folder a drop reserved and never used, given back.
 *
 * Reserving the name a dropped folder lands under is a `mkdir`: it is what
 * makes the name held, which is the whole point of it. So a reader who pressed
 * stop before a byte went out was left with an empty folder — and their next
 * try at the same folder found that name taken and became `ardoise (1)`, then
 * `ardoise (2)`. Reported as a row of empty folders and a name that kept
 * moving.
 *
 * Which makes the removal the dangerous half, and the rule is narrow: only a
 * folder a reservation here created, still the folder it created, and holding
 * no file at any depth. One file in it and nothing is touched — somebody's
 * bytes arrived, and they are worth more than a tidy name.
 */

let envContext;
let service;

const build = async () => {
  envContext = await setupTestEnv({ tag: 'folder-upload-release-' });
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
const SOMEBODY_ELSE = { user: { id: 'somebody-else' } };

const reserve = (destinationRoot, uploadBatchId, sourceRoot = 'ardoise') =>
  service.reserveFolderUploadTarget({
    destinationRoot,
    logicalBase: 'Inbox',
    sourceRoot,
    context: OWNER,
    uploadBatchId,
  });

const release = (destinationRoot, uploadBatchId, context = OWNER, sourceRoot = 'ardoise') =>
  service.releaseFolderUploadTarget({
    destinationRoot,
    sourceRoot,
    context,
    uploadBatchId,
  });

describe('a folder reserved for a batch that sent nothing', () => {
  it('is given back, and the name is free again', async () => {
    const destinationRoot = await build();
    expect(await reserve(destinationRoot, 'batch-release-01')).toBe('ardoise');
    // What an upload aborted on its way leaves: the folders it had made for the
    // files it was about to write, and not one file.
    await fs.mkdir(path.join(destinationRoot, 'ardoise', '2026', 'week-1'), { recursive: true });

    expect(await release(destinationRoot, 'batch-release-01')).toBe(true);
    expect(await fs.readdir(destinationRoot)).toEqual([]);

    // Which is the point of giving it back: the next try is `ardoise` again,
    // where before it was `ardoise (1)`.
    expect(await reserve(destinationRoot, 'batch-release-02')).toBe('ardoise');
  });

  it('is kept, with everything in it, once a file has arrived', async () => {
    const destinationRoot = await build();
    await reserve(destinationRoot, 'batch-arrived-01');
    const landed = path.join(destinationRoot, 'ardoise', '2026');
    await fs.mkdir(landed, { recursive: true });
    await fs.writeFile(path.join(landed, 'note.txt'), 'the bytes that arrived');

    expect(await release(destinationRoot, 'batch-arrived-01')).toBe(false);
    expect(await fs.readFile(path.join(landed, 'note.txt'), 'utf8')).toBe('the bytes that arrived');
  });

  /**
   * A batch id is the client's to choose, so the register is the asker's own.
   * Guessing somebody else's batch has to find nothing, or naming it would be a
   * way of having their folder removed.
   */
  it('is not given back to another reader who names the same batch', async () => {
    const destinationRoot = await build();
    await reserve(destinationRoot, 'batch-guessed-01');

    expect(await release(destinationRoot, 'batch-guessed-01', SOMEBODY_ELSE)).toBe(false);
    expect(await fs.readdir(destinationRoot)).toEqual(['ardoise']);
  });

  /**
   * And it is the folder that was created, not merely its name. A reservation
   * lives for hours; in that time the folder can be deleted and another one put
   * under the same name, which is a folder nothing here created.
   */
  it('is not given back when another folder has taken its place', async () => {
    const destinationRoot = await build();
    await reserve(destinationRoot, 'batch-replaced-01');
    const reserved = path.join(destinationRoot, 'ardoise');
    await fs.rmdir(reserved);
    await fs.mkdir(reserved);

    expect(await release(destinationRoot, 'batch-replaced-01')).toBe(false);
    expect(await fs.readdir(destinationRoot)).toEqual(['ardoise']);
  });

  /**
   * "No file at any depth" is read as "folders and nothing else": a symbolic
   * link is not a file, and a link to a folder would be walked into by anything
   * that asked the question with a plain `stat`.
   */
  it('is kept when something other than a folder sits in it', async () => {
    const destinationRoot = await build();
    await reserve(destinationRoot, 'batch-linked-01');
    const elsewhere = path.join(envContext.volumeDir, 'Papers');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(destinationRoot, 'ardoise', 'theirs'));

    expect(await release(destinationRoot, 'batch-linked-01')).toBe(false);
    expect(await fs.readdir(path.join(destinationRoot, 'ardoise'))).toEqual(['theirs']);
  });
});
