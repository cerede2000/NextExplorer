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

/**
 * The three questions `getShareAccess` answers in sequence, each covered on its
 * own before the function is split along them: may this share be opened at all,
 * may this caller open it, and what does the location underneath still allow.
 *
 * Fifty-three paths through one function, and eight tests. These are the ones
 * that decide whether a link hands out more than its owner meant to.
 */

const accessTo = (share, context = {}, innerPath = '') =>
  accessManager.getShareAccess(
    { user: context.user ?? null, guestSession: context.guestSession ?? null },
    share.shareToken,
    innerPath
  );

describe('accessManager — who may open a share', () => {
  it('refuses a signed-in account that the share was not shared with', async () => {
    const owner = await createOwner('targeted-owner');
    const stranger = await createOwner('targeted-stranger');
    const invited = await createOwner('targeted-invited');
    await createSharedFolder('targeted');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'targeted',
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'users',
      userIds: [invited.id],
    });

    const access = await accessTo(share, { user: stranger });

    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toBe('Access denied');
  });

  it('admits the account the share was shared with', async () => {
    const owner = await createOwner('invited-owner');
    const invited = await createOwner('invited-guest');
    await createSharedFolder('invited');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'invited',
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'users',
      userIds: [invited.id],
    });

    const access = await accessTo(share, { user: invited });

    expect(access.canAccess).toBe(true);
    expect(access.isShared).toBe(true);
  });

  it('turns away a visitor carrying neither an account nor a guest session', async () => {
    const owner = await createOwner('anonymous');
    await createSharedFolder('anonymous-share');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'anonymous-share',
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'anyone',
    });

    const access = await accessTo(share);

    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toBe('Share access required');
  });

  /**
   * Being signed in is not the same as knowing the password. Without this, any
   * account opening a protected link walked past the prompt its owner set up.
   */
  it('still asks for the password of an account that never entered it', async () => {
    const owner = await createOwner('password-owner');
    const visitor = await createOwner('password-visitor');
    await createSharedFolder('password-share');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'password-share',
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'anyone',
      password: 'a-real-password',
    });

    const access = await accessTo(share, { user: visitor });

    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toBe('Password verification required');
  });

  it('admits the same account once it holds a guest session for that share', async () => {
    const owner = await createOwner('password-verified-owner');
    const visitor = await createOwner('password-verified-visitor');
    await createSharedFolder('password-verified');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'password-verified',
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'anyone',
      password: 'a-real-password',
    });
    const guestSession = await guestSessionService.createGuestSession({
      shareId: share.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    const access = await accessTo(share, { user: visitor, guestSession });

    expect(access.canAccess).toBe(true);
  });

  /**
   * A sharing type nobody wrote a branch for must not fall through to the grant
   * at the bottom of the function.
   *
   * The database refuses to hold one — there is a CHECK constraint — so the
   * branch guards against a schema this application does not have yet, and the
   * only honest way in is the share cache the function itself accepts. That is
   * not a contrivance: the cache is how routes hand it a share they already
   * loaded, so a future type would arrive through exactly this door.
   */
  it('fails closed on a sharing type it does not know', async () => {
    const owner = await createOwner('unknown-type');
    await createSharedFolder('unknown-type-share');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'unknown-type-share',
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'anyone',
    });

    const shareCache = new Map([[share.shareToken, { ...share, sharingType: 'everyone-forever' }]]);

    const access = await accessManager.getShareAccess(
      { user: owner, guestSession: null },
      share.shareToken,
      '',
      { shareCache }
    );

    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toBe('Unknown sharing type');
  });
});

describe('accessManager — what the location underneath still allows', () => {
  it('refuses a share whose source has since been hidden', async () => {
    const owner = await createOwner('hidden-source');
    await createSharedFolder('hidden-source-share');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'hidden-source-share',
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'anyone',
      accessMode: 'readwrite',
    });
    const guestSession = await guestSessionService.createGuestSession({
      shareId: share.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    const access = await accessManager.getShareAccess(
      { user: null, guestSession },
      share.shareToken,
      '',
      { permissionResolver: async () => 'hidden' }
    );

    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toBe('Path is hidden');
  });

  it('refuses a share pointing at a personal volume that no longer exists', async () => {
    const owner = await createOwner('missing-volume');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'no-such-volume-id/inner',
      sourceSpace: 'user_volume',
      isDirectory: true,
      sharingType: 'anyone',
    });
    const guestSession = await guestSessionService.createGuestSession({
      shareId: share.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    const access = await accessTo(share, { guestSession });

    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toBe('Share source volume not found');
  });

  it('refuses a share pointing at a personal volume with no id at all', async () => {
    const owner = await createOwner('empty-volume-path');

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: '/',
      sourceSpace: 'user_volume',
      isDirectory: true,
      sharingType: 'anyone',
    });
    const guestSession = await guestSessionService.createGuestSession({
      shareId: share.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    const access = await accessTo(share, { guestSession });

    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toBe('Share source volume is invalid');
  });

  /**
   * A share may only hand out a volume its own owner holds. Without this, an
   * account that once had a volume assigned could keep sharing it after it was
   * reassigned to somebody else.
   */
  it('refuses a share whose source volume belongs to another account', async () => {
    const owner = await createOwner('volume-owner');
    const otherAccount = await createOwner('volume-other');
    const volumeDir = await createSharedFolder('someone-elses-volume');

    const userVolumes = envContext.requireFresh('src/services/userVolumesService');
    const volume = await userVolumes.addVolumeToUser({
      userId: otherAccount.id,
      label: 'Theirs',
      volumePath: volumeDir,
      accessMode: 'readwrite',
    });

    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: `${volume.id}/`,
      sourceSpace: 'user_volume',
      isDirectory: true,
      sharingType: 'anyone',
    });
    const guestSession = await guestSessionService.createGuestSession({
      shareId: share.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    const access = await accessTo(share, { guestSession });

    expect(access.canAccess).toBe(false);
    expect(access.denialReason).toBe('Share source volume mismatch');
  });
});

describe('accessManager — what a share grants', () => {
  const openShare = async (name, overrides) => {
    const owner = await createOwner(name);
    await createSharedFolder(name);
    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: name,
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'anyone',
      ...overrides,
    });
    const guestSession = await guestSessionService.createGuestSession({
      shareId: share.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });
    return { owner, share, guestSession };
  };

  it('grants nothing beyond reading on a read-only share', async () => {
    const { share, guestSession } = await openShare('grant-readonly', {
      accessMode: 'readonly',
    });

    const access = await accessTo(share, { guestSession });

    expect(access).toMatchObject({
      canRead: true,
      canWrite: false,
      canDelete: false,
      canUpload: false,
      canCreateFolder: false,
      canCreateFile: false,
      effectivePermission: 'ro',
    });
  });

  it('grants writing on a read-write share', async () => {
    const { share, guestSession } = await openShare('grant-readwrite', {
      accessMode: 'readwrite',
    });

    const access = await accessTo(share, { guestSession });

    expect(access).toMatchObject({
      canWrite: true,
      canDelete: true,
      canUpload: true,
      canCreateFolder: true,
      canCreateFile: true,
      effectivePermission: 'rw',
    });
  });

  it.each([
    ['allowDelete', 'canDelete'],
    ['allowUpload', 'canUpload'],
    ['allowCreateFolder', 'canCreateFolder'],
    ['allowCreateFile', 'canCreateFile'],
  ])('withholds %s on its own, leaving the rest of the write grant', async (flag, granted) => {
    const { share, guestSession } = await openShare(`grant-without-${flag}`, {
      accessMode: 'readwrite',
      [flag]: false,
    });

    const access = await accessTo(share, { guestSession });

    expect(access[granted]).toBe(false);
    expect(access.canWrite).toBe(true);
  });

  it('never lets a share be shared again', async () => {
    const { share, guestSession } = await openShare('grant-no-resharing', {
      accessMode: 'readwrite',
    });

    const access = await accessTo(share, { guestSession });

    expect(access.canShare).toBe(false);
  });

  it('tells the owner that it is theirs, and a visitor that it is not', async () => {
    const { owner, share, guestSession } = await openShare('grant-ownership', {});
    const visitor = await createOwner('grant-ownership-visitor');

    const asOwner = await accessTo(share, { user: owner, guestSession });
    const asVisitor = await accessTo(share, { user: visitor, guestSession });

    expect(asOwner.shareInfo.isOwner).toBe(true);
    expect(asVisitor.shareInfo.isOwner).toBe(false);
  });
});
