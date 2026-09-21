import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * With AUTH_MODE=disabled the middleware injects one synthetic admin for every
 * caller and never reads a guest session. A password check that asks "are you
 * the owner?" therefore refuses everyone, forever: the share password went from
 * a barrier for strangers to a lock on the whole share. Nothing was protected
 * either way — that deployment hands the entire filesystem to every visitor.
 */

let envContext;
let accessManager;
let sharesService;
let share;

const ANONYMOUS = {
  id: 'anonymous',
  username: 'anonymous',
  roles: ['admin'],
};

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'share-password-no-auth-',
    env: { AUTH_MODE: 'disabled' },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/utils/pathUtils',
      'src/services/db',
      'src/services/users',
      'src/services/sharesService',
      'src/services/accessManager',
      'src/services/accessControlService',
    ],
  });

  accessManager = envContext.requireFresh('src/services/accessManager');
  sharesService = envContext.requireFresh('src/services/sharesService');
  const usersService = envContext.requireFresh('src/services/users');

  const owner = await usersService.createLocalUser({
    email: 'owner@example.com',
    username: 'owner',
    displayName: 'Owner',
    password: 'secret123',
    roles: ['user'],
  });

  await fs.mkdir(path.join(envContext.volumeDir, 'shared'), { recursive: true });
  share = await sharesService.createShare({
    ownerId: owner.id,
    sourcePath: 'shared',
    sourceSpace: 'volume',
    isDirectory: true,
    accessMode: 'readonly',
    sharingType: 'anyone',
    password: 'link-password',
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

describe('Share password with authentication disabled', () => {
  it('does not lock the share behind a check nobody can pass', async () => {
    const stored = await sharesService.getShareByToken(share.shareToken);
    expect(stored.hasPassword).toBe(true);
    expect(accessManager.sharePasswordApplies(stored, ANONYMOUS)).toBe(false);

    const access = await accessManager.getShareAccess(
      { user: ANONYMOUS, guestSession: null },
      share.shareToken,
      ''
    );
    expect(access.canAccess).toBe(true);
  });
});
