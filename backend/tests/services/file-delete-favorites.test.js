import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

let envContext;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'file-delete-favorites-test-',
    env: {
      USER_VOLUMES: 'true',
    },
    modules: [
      'src/services/db',
      'src/services/users',
      'src/services/userVolumesService',
      'src/services/favoritesService',
      'src/services/fileTransferService',
      'src/services/accessManager',
      'src/utils/pathUtils',
    ],
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

describe('File deletion favorite cleanup', () => {
  it('removes favorites that point to a deleted folder tree', async () => {
    const usersService = envContext.requireFresh('src/services/users');
    const userVolumesService = envContext.requireFresh('src/services/userVolumesService');
    const favoritesService = envContext.requireFresh('src/services/favoritesService');
    const { deleteItems } = envContext.requireFresh('src/services/fileTransferService');

    const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-favorites');
    await fs.mkdir(path.join(assignedRoot, 'folder', 'nested'), { recursive: true });
    await fs.mkdir(path.join(assignedRoot, 'sibling'), { recursive: true });

    const user = await usersService.createLocalUser({
      email: 'favorite-cleanup@example.com',
      username: 'favorite-cleanup',
      displayName: 'Favorite Cleanup',
      password: 'secret123',
      roles: ['user'],
    });

    await userVolumesService.addVolumeToUser({
      userId: user.id,
      label: 'FavVol',
      volumePath: assignedRoot,
      accessMode: 'readwrite',
    });

    await favoritesService.addFavorite(user, { path: 'FavVol/folder' });
    await favoritesService.addFavorite(user, { path: 'FavVol/folder/nested' });
    await favoritesService.addFavorite(user, { path: 'FavVol/sibling' });

    const result = await deleteItems([{ path: 'FavVol', name: 'folder', kind: 'directory' }], {
      user,
    });

    expect(result).toEqual([
      {
        path: 'FavVol/folder',
        status: 'deleted',
        removedFavoriteCount: 2,
      },
    ]);

    const remainingFavorites = await favoritesService.getFavorites(user.id);
    expect(remainingFavorites.map((favorite) => favorite.path)).toEqual(['FavVol/sibling']);
  });
});
