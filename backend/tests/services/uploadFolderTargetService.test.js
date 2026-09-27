import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The name a picked folder takes in its destination.
 *
 * The destination is a real one under the volume, because the folder about to
 * be created is authorized by its logical path before the mkdir: a name an
 * administrator hid, or the zone's own, never reaches the disk. What that
 * refusal leaves is covered from the routes, in `upload-landing.test.js`.
 */

let envContext;
let service;

const OWNER = { user: { id: 'test-user' } };

const build = async () => {
  envContext = await setupTestEnv({ tag: 'upload-folder-target-' });
  service = envContext.requireFresh('src/services/uploadFolderTargetService');
  const destinationRoot = path.join(envContext.volumeDir, 'Inbox');
  await fs.mkdir(destinationRoot, { recursive: true });
  return destinationRoot;
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
  service = null;
});

describe('folder upload target reservation', () => {
  it('keeps a duplicate folder batch together under one available directory', async () => {
    const destinationRoot = await build();
    await fs.mkdir(path.join(destinationRoot, 'photos'));

    const resolve = (relativePath, uploadBatchId) =>
      service.resolveFolderUploadRelativePath({
        relativePath,
        destinationRoot,
        logicalBase: 'Inbox',
        context: OWNER,
        uploadBatchId,
      });

    const first = await resolve('photos/2026/one.jpg', 'folder-upload-0001');
    const second = await resolve('photos/2026/two.jpg', 'folder-upload-0001');
    const nextBatch = await resolve('photos/2026/three.jpg', 'folder-upload-0002');

    expect(first).toBe('photos (1)/2026/one.jpg');
    expect(second).toBe('photos (1)/2026/two.jpg');
    expect(nextBatch).toBe('photos (2)/2026/three.jpg');
  });

  it('atomically reserves a distinct destination before folder files are queued', async () => {
    const destinationRoot = await build();
    await fs.mkdir(path.join(destinationRoot, 'photos'));

    const targetRoots = await Promise.all(
      Array.from({ length: 3 }, () =>
        service.reserveFolderUploadTarget({
          destinationRoot,
          logicalBase: 'Inbox',
          sourceRoot: 'photos',
          context: OWNER,
        })
      )
    );

    expect(targetRoots.sort()).toEqual(['photos (1)', 'photos (2)', 'photos (3)']);
  });

  it('rejects a nested path as a folder root reservation', async () => {
    const destinationRoot = await build();

    await expect(
      service.reserveFolderUploadTarget({
        destinationRoot,
        logicalBase: 'Inbox',
        sourceRoot: 'photos/2026',
        context: OWNER,
      })
    ).rejects.toThrow('top-level folder name');
  });
});
