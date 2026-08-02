import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * accessManager decides, for every request, what a caller may do with a path.
 * It was only exercised indirectly through route tests, so the boundaries that
 * matter most — guests, expired shares, share permissions capped by the
 * underlying location — had no test of their own.
 */

let envContext;
let accessManager;
let usersService;
let sharesService;
let guestSessionService;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'access-manager-',
    env: { USER_DIR_ENABLED: 'true' },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/utils/pathUtils',
      'src/services/db',
      'src/services/users',
      'src/services/sharesService',
      'src/services/guestSessionService',
      'src/services/accessManager',
      'src/services/accessControlService',
    ],
  });

  accessManager = envContext.requireFresh('src/services/accessManager');
  usersService = envContext.requireFresh('src/services/users');
  sharesService = envContext.requireFresh('src/services/sharesService');
  guestSessionService = envContext.requireFresh('src/services/guestSessionService');
});

afterAll(async () => {
  await envContext.cleanup();
});

const createOwner = async (suffix) =>
  usersService.createLocalUser({
    email: `owner-${suffix}@example.com`,
    username: `owner-${suffix}`,
    displayName: `Owner ${suffix}`,
    password: 'secret123',
    roles: ['user'],
  });

const createSharedFolder = async (name) => {
  const folder = path.join(envContext.volumeDir, name);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'inside.txt'), 'content');
  return folder;
};

describe('accessManager — personal space', () => {
  it('denies guests, and requires authentication', async () => {
    const guestOnly = await accessManager.getPersonalAccess(
      { user: null, guestSession: { id: 'g1', shareId: 'sX' } },
      ''
    );
    expect(guestOnly.canAccess).toBe(false);
    expect(guestOnly.denialReason).toMatch(/guest/i);

    const anonymous = await accessManager.getPersonalAccess({ user: null }, '');
    expect(anonymous.canAccess).toBe(false);
  });

  it('grants the owner full access to their own space', async () => {
    const access = await accessManager.getPersonalAccess({ user: { id: 'user-1' } }, 'notes');
    expect(access.canAccess).toBe(true);
    expect(access.canWrite).toBe(true);
    expect(access.canDelete).toBe(true);
    expect(access.effectivePermission).toBe('rw');
  });
});

describe('accessManager — shares', () => {
  it('refuses an unknown or missing token', async () => {
    const missing = await accessManager.getShareAccess({ user: null }, '', '');
    expect(missing.canAccess).toBe(false);

    const unknown = await accessManager.getShareAccess({ user: null }, 'does-not-exist', '');
    expect(unknown.canAccess).toBe(false);
    expect(unknown.denialReason).toMatch(/not found/i);
  });

  it('refuses an expired share even with a valid guest session', async () => {
    const owner = await createOwner('expired');
    await createSharedFolder('expired-share');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'expired-share',
      sourceSpace: 'volume',
      isDirectory: true,
      accessMode: 'readonly',
      sharingType: 'anyone',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const guestSession = await guestSessionService.createGuestSession({
      shareId: share.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    const access = await accessManager.getShareAccess(
      { user: null, guestSession },
      share.shareToken,
      ''
    );
    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toMatch(/expired/i);
  });

  it('rejects a guest session issued for another share', async () => {
    const owner = await createOwner('cross');
    await createSharedFolder('cross-a');
    await createSharedFolder('cross-b');

    const [shareA, shareB] = await Promise.all([
      sharesService.createShare({
        ownerId: owner.id,
        sourcePath: 'cross-a',
        sourceSpace: 'volume',
        isDirectory: true,
        accessMode: 'readonly',
        sharingType: 'anyone',
      }),
      sharesService.createShare({
        ownerId: owner.id,
        sourcePath: 'cross-b',
        sourceSpace: 'volume',
        isDirectory: true,
        accessMode: 'readonly',
        sharingType: 'anyone',
      }),
    ]);

    const sessionForA = await guestSessionService.createGuestSession({
      shareId: shareA.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    const access = await accessManager.getShareAccess(
      { user: null, guestSession: sessionForA },
      shareB.shareToken,
      ''
    );
    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toMatch(/guest session/i);
  });

  it('requires authentication for a user-targeted share', async () => {
    const owner = await createOwner('targeted');
    await createSharedFolder('targeted-share');

    const recipient = await usersService.createLocalUser({
      email: 'recipient@example.com',
      username: 'recipient',
      displayName: 'Recipient',
      password: 'secret123',
      roles: ['user'],
    });

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'targeted-share',
      sourceSpace: 'volume',
      isDirectory: true,
      accessMode: 'readonly',
      sharingType: 'users',
      userIds: [recipient.id],
    });

    const anonymous = await accessManager.getShareAccess({ user: null }, share.shareToken, '');
    expect(anonymous.canAccess).toBe(false);
    expect(anonymous.denialReason).toMatch(/authentication/i);

    // Authenticated, but not one of the named recipients.
    const stranger = await usersService.createLocalUser({
      email: 'stranger@example.com',
      username: 'stranger',
      displayName: 'Stranger',
      password: 'secret123',
      roles: ['user'],
    });
    const denied = await accessManager.getShareAccess({ user: stranger }, share.shareToken, '', {
      permissionResolver: async () => 'rw',
    });
    expect(denied.canAccess).toBe(false);

    // The named recipient gets in.
    const allowed = await accessManager.getShareAccess({ user: recipient }, share.shareToken, '', {
      permissionResolver: async () => 'rw',
    });
    expect(allowed.canAccess).toBe(true);
  });

  it('caps a read-write share by the read-only permission of its source', async () => {
    const owner = await createOwner('capped');
    await createSharedFolder('capped-share');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'capped-share',
      sourceSpace: 'volume',
      isDirectory: true,
      accessMode: 'readwrite',
      sharingType: 'anyone',
    });
    const guestSession = await guestSessionService.createGuestSession({
      shareId: share.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    // Baseline: the share grants write while the source allows it.
    const writable = await accessManager.getShareAccess(
      { user: null, guestSession },
      share.shareToken,
      '',
      { permissionResolver: async () => 'rw' }
    );
    expect(writable.canAccess).toBe(true);
    expect(writable.canWrite).toBe(true);

    // An admin marking the source read-only must take effect immediately,
    // without touching the share itself.
    const readOnly = await accessManager.getShareAccess(
      { user: null, guestSession },
      share.shareToken,
      '',
      { permissionResolver: async () => 'ro' }
    );
    expect(readOnly.canAccess).toBe(true);
    expect(readOnly.canWrite).toBe(false);

    // Hiding the source removes access entirely.
    const hidden = await accessManager.getShareAccess(
      { user: null, guestSession },
      share.shareToken,
      '',
      { permissionResolver: async () => 'hidden' }
    );
    expect(hidden.canAccess).toBe(false);
  });
});

describe('accessManager — path resolution', () => {
  it('refuses to resolve a path that escapes its space', async () => {
    const context = { user: { id: 'admin', roles: ['admin'] } };
    await expect(
      accessManager.resolvePathWithAccess(context, '../../etc/passwd')
    ).rejects.toThrow();
  });
});
