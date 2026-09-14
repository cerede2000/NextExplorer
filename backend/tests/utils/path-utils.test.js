import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { setupTestEnv } from '../helpers/env-test-utils.js';

let envContext;
let pathUtils;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'path-utils-test-',
    modules: ['src/utils/pathUtils'],
  });
  pathUtils = envContext.requireFresh('src/utils/pathUtils');
});

afterAll(async () => {
  await envContext.cleanup();
});

describe('Path Utilities', () => {
  describe('normalizeRelativePath', () => {
    it('should normalize slashes and reject traversal', () => {
      expect(pathUtils.normalizeRelativePath('folder//nested')).toBe('folder/nested');
      expect(pathUtils.normalizeRelativePath('/')).toBe('');
      expect(pathUtils.normalizeRelativePath('')).toBe('');
      expect(pathUtils.normalizeRelativePath('./foo/../bar')).toBe('bar');
      expect(() => pathUtils.normalizeRelativePath('..')).toThrow(/Invalid path/);
    });
  });

  describe('resolveVolumePath', () => {
    it('should protect volume root boundaries', async () => {
      const resolved = await pathUtils.resolveVolumePath('photo/jpg');
      expect(resolved).toBe(path.resolve(envContext.volumeDir, 'photo/jpg'));
      await expect(pathUtils.resolveVolumePath('../outside')).rejects.toThrow(/outside/);
    });
  });

  describe('combineRelativePath and splitName', () => {
    it('should combine paths correctly', () => {
      expect(pathUtils.combineRelativePath('a//b', 'file.txt')).toBe('a/b/file.txt');
    });

    it('should split names correctly', () => {
      const { base, extension } = pathUtils.splitName('archive.tar.gz');
      expect(base).toBe('archive.tar');
      expect(extension).toBe('.gz');

      const noExt = pathUtils.splitName('README');
      expect(noExt.base).toBe('README');
      expect(noExt.extension).toBe('');
    });
  });

  describe('ensureValidName', () => {
    it('should reject invalid names', () => {
      expect(pathUtils.ensureValidName('Default')).toBe('Default');
      expect(() => pathUtils.ensureValidName('')).toThrow(/Name cannot be empty/);
      expect(() => pathUtils.ensureValidName('bad/name')).toThrow(/path separators/);
      expect(() => pathUtils.ensureValidName('..')).toThrow(/not allowed/);
    });
  });

  describe('findAvailableName and findAvailableFolderName', () => {
    it('should avoid collisions', async () => {
      const filePath = path.join(envContext.volumeDir, 'duplicate.txt');
      await fsPromises.writeFile(filePath, 'data');

      const nextName = await pathUtils.findAvailableName(envContext.volumeDir, 'duplicate.txt');
      expect(nextName).toBe('duplicate (1).txt');

      const firstName = await pathUtils.findAvailableName(envContext.volumeDir, 'new.txt');
      expect(firstName).toBe('new.txt');

      await fsPromises.mkdir(path.join(envContext.volumeDir, 'Untitled Folder'));
      const folderName = await pathUtils.findAvailableFolderName(envContext.volumeDir);
      expect(folderName).toBe('Untitled Folder 2');
    });
  });

  describe('getUserFolderName', () => {
    it('should default to stable id-first ordering', () => {
      const name = pathUtils.getUserFolderName({
        id: '11111111-2222-3333-4444-555555555555',
        username: 'alice',
        email: 'alice@example.com',
      });
      expect(name).toBe('11111111-2222-3333-4444-555555555555');
    });

    it('should respect USER_FOLDER_NAME_ORDER', async () => {
      const customEnv = await setupTestEnv({
        tag: 'path-utils-user-folder-order-',
        modules: ['src/utils/pathUtils'],
        env: {
          USER_FOLDER_NAME_ORDER: 'username,id',
        },
      });

      try {
        const customPathUtils = customEnv.requireFresh('src/utils/pathUtils');

        const fromUsername = customPathUtils.getUserFolderName({
          id: '11111111-2222-3333-4444-555555555555',
          username: 'alice',
          email: 'alice@example.com',
        });
        expect(fromUsername).toBe('alice');

        const fallsBackToId = customPathUtils.getUserFolderName({
          id: '11111111-2222-3333-4444-555555555555',
          username: 'bad/name',
          email: 'alice@example.com',
        });
        expect(fallsBackToId).toBe('11111111-2222-3333-4444-555555555555');
      } finally {
        await customEnv.cleanup();
      }
    });
  });

  describe('resolveItemPaths', () => {
    it('should return normalized relative and absolute paths', async () => {
      const item = { name: 'file.txt', path: 'docs/reports' };
      const resolved = await pathUtils.resolveItemPaths(item);

      expect(resolved.relativePath).toBe('docs/reports/file.txt');
      expect(resolved.absolutePath).toBe(
        path.resolve(envContext.volumeDir, 'docs/reports/file.txt')
      );
    });
  });
});

/**
 * What a refusal from here becomes on the wire.
 *
 * These functions refuse on behalf of every route that takes a path, and they
 * refused with plain Errors: no status, so the error handler answered 500 and
 * logged a stack for a request that was simply not allowed, or not well formed,
 * or asked for a share that no longer exists. The messages were always right;
 * the class decides the status, so the class is what is held here, alongside
 * the message the older assertions above already read.
 */
describe('the status a refusal carries', () => {
  const errorOf = (fn) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return null;
  };
  const rejectionOf = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    return null;
  };

  it('is 400 for a path that climbs out of the volume, which is a malformed request', () => {
    const error = errorOf(() => pathUtils.normalizeRelativePath('../../etc/passwd'));

    expect(error?.message).toMatch(/Traversal outside the volume root/);
    expect(error?.statusCode).toBe(400);
  });

  it.each([[''], ['bad/name'], ['..']])('is 400 for a name that cannot be used: %j', (name) => {
    expect(errorOf(() => pathUtils.ensureValidName(name))?.statusCode).toBe(400);
  });

  it('is 400 for an item without a name', async () => {
    const error = await rejectionOf(pathUtils.resolveItemPaths({ path: 'Album' }));

    expect(error?.message).toMatch(/must include a name/);
    expect(error?.statusCode).toBe(400);
  });

  it('is 403 for a link inside the volume that leads out of it', async () => {
    const outside = path.join(envContext.tmpRoot, 'status-outside');
    await fsPromises.mkdir(outside, { recursive: true });
    await fsPromises.symlink(outside, path.join(envContext.volumeDir, 'status-escape'));

    const error = await rejectionOf(pathUtils.resolveVolumePath('status-escape'));

    expect(error?.message).toMatch(/outside the configured volume/);
    expect(error?.statusCode).toBe(403);
  });

  it('is 403 for a personal path when personal folders are off', async () => {
    const error = await rejectionOf(pathUtils.resolvePersonalPath('', { id: 'someone' }));

    expect(error?.message).toMatch(/Personal directories are disabled/);
    expect(error?.statusCode).toBe(403);
  });

  it('is 404 for a share that does not exist', async () => {
    const error = await rejectionOf(pathUtils.resolveLogicalPath('share/no-such-token'));

    expect(error?.message).toMatch(/Share not found/);
    expect(error?.statusCode).toBe(404);
  });
});
