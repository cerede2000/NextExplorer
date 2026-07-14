import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import uploadFolderTargetService from '../../src/services/uploadFolderTargetService.js';

const { resolveFolderUploadRelativePath } = uploadFolderTargetService;

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('folder upload target reservation', () => {
  it('keeps a duplicate folder batch together under one available directory', async () => {
    const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-folder-target-'));
    roots.push(destinationRoot);
    await fs.mkdir(path.join(destinationRoot, 'photos'));

    const context = { user: { id: 'test-user' } };
    const first = await resolveFolderUploadRelativePath({
      relativePath: 'photos/2026/one.jpg',
      destinationRoot,
      context,
      uploadBatchId: 'folder-upload-0001',
    });
    const second = await resolveFolderUploadRelativePath({
      relativePath: 'photos/2026/two.jpg',
      destinationRoot,
      context,
      uploadBatchId: 'folder-upload-0001',
    });
    const nextBatch = await resolveFolderUploadRelativePath({
      relativePath: 'photos/2026/three.jpg',
      destinationRoot,
      context,
      uploadBatchId: 'folder-upload-0002',
    });

    expect(first).toBe('photos (1)/2026/one.jpg');
    expect(second).toBe('photos (1)/2026/two.jpg');
    expect(nextBatch).toBe('photos (2)/2026/three.jpg');
  });
});
