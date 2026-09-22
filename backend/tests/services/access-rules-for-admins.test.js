import { describe, it, expect } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Whom an access rule holds.
 *
 * An administrator used to sit outside read-only rules and inside hidden ones,
 * which is neither and was written nowhere: a read-only rule left the Create
 * button on a folder for them, and they wrote into it (nxzai/NextExplorer#407),
 * while a hidden rule took a folder away from the one account meant to manage
 * it, with no way to say otherwise.
 *
 * It is one switch now, the same whatever the rule grants: a rule says whether
 * it holds administrators, and one setting above the rules holds them to all of
 * them at once. What a rule stored before the switch existed does is unchanged,
 * so an upgrade moves nothing.
 */

const MODULES = [
  'src/services/settingsService',
  'src/services/accessControlService',
  'src/services/accessManager',
];

const withAccess = async (run) => {
  const env = await setupTestEnv({ tag: 'access-admins-', modules: MODULES });
  try {
    await run({
      env,
      settings: env.requireFresh('src/services/settingsService'),
      accessControl: env.requireFresh('src/services/accessControlService'),
      accessManager: env.requireFresh('src/services/accessManager'),
    });
  } finally {
    await env.cleanup();
  }
};

/** Store the whole access section, rules and setting together. */
const store = (settings, access) => settings.setSystemSetting('system', 'access', access);

const ADMIN = { id: 'admin-1', username: 'admin', roles: ['admin'] };
const REGULAR = { id: 'user-1', username: 'user', roles: ['user'] };

const rule = (permissions, extra = {}) => ({
  path: 'Team',
  recursive: true,
  permissions,
  ...extra,
});

describe('a rule that says nothing about administrators', () => {
  /**
   * The upgrade case, and the only one that can move behaviour by itself: a
   * rule written before the switch existed has to keep doing what it did.
   */
  it('keeps doing what it did: read-only spared them, hidden did not', async () => {
    await withAccess(async ({ settings, accessControl }) => {
      await store(settings, { rules: [{ path: 'Team', recursive: true, permissions: 'ro' }] });
      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: true })).toBe(
        'rw'
      );
      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: false })).toBe(
        'ro'
      );

      await store(settings, { rules: [{ path: 'Team', recursive: true, permissions: 'hidden' }] });
      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: true })).toBe(
        'hidden'
      );
    });
  });
});

describe('a rule that says it holds administrators', () => {
  it('makes a read-only folder read-only for them too', async () => {
    await withAccess(async ({ settings, accessControl }) => {
      await store(settings, { rules: [rule('ro', { appliesToAdmins: true })] });

      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: true })).toBe(
        'ro'
      );
    });
  });

  it('hides a hidden folder from them too', async () => {
    await withAccess(async ({ settings, accessControl }) => {
      await store(settings, { rules: [rule('hidden', { appliesToAdmins: true })] });

      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: true })).toBe(
        'hidden'
      );
    });
  });
});

describe('a rule that says it does not hold administrators', () => {
  /** The half that was impossible before: a folder hidden from everybody but them. */
  it('leaves a hidden folder in plain sight for them', async () => {
    await withAccess(async ({ settings, accessControl }) => {
      await store(settings, { rules: [rule('hidden', { appliesToAdmins: false })] });

      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: true })).toBe(
        'rw'
      );
      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: false })).toBe(
        'hidden'
      );
    });
  });

  /**
   * Passed over, not obeyed: the rule is not there for an administrator, so
   * whatever rule comes after it still has its say.
   */
  it('lets a later rule decide instead of standing in its way', async () => {
    await withAccess(async ({ settings, accessControl }) => {
      await store(settings, {
        rules: [
          { path: 'Team', recursive: true, permissions: 'hidden', appliesToAdmins: false },
          { path: 'Team', recursive: true, permissions: 'ro', appliesToAdmins: true },
        ],
      });

      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: true })).toBe(
        'ro'
      );
      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: false })).toBe(
        'hidden'
      );
    });
  });
});

describe('the setting above the rules', () => {
  it('holds administrators to every rule, whatever each rule says', async () => {
    await withAccess(async ({ settings, accessControl }) => {
      await store(settings, {
        applyToAdmins: true,
        rules: [
          { path: 'Team', recursive: true, permissions: 'ro', appliesToAdmins: false },
          { path: 'Vault', recursive: true, permissions: 'hidden', appliesToAdmins: false },
        ],
      });

      expect(await accessControl.getPermissionForPath('Team/plan.txt', { isAdmin: true })).toBe(
        'ro'
      );
      expect(await accessControl.getPermissionForPath('Vault/key.txt', { isAdmin: true })).toBe(
        'hidden'
      );
    });
  });

  it('is kept when only the rules are saved, and the rules when only it is', async () => {
    await withAccess(async ({ settings }) => {
      await store(settings, { applyToAdmins: true, rules: [rule('ro')] });

      await settings.setSettings({ access: { rules: [rule('hidden')] } });
      let stored = (await settings.getSystemSettings()).access;
      expect(stored.applyToAdmins).toBe(true);
      expect(stored.rules[0].permissions).toBe('hidden');

      await settings.setSettings({ access: { applyToAdmins: false } });
      stored = (await settings.getSystemSettings()).access;
      expect(stored.applyToAdmins).toBe(false);
      expect(stored.rules).toHaveLength(1);
    });
  });
});

describe('what the application does with it', () => {
  const access = (accessManager, user) =>
    accessManager.getAccessInfo({ user, guestSession: null }, 'Team/plan.txt');

  it('offers an administrator no way to write where a rule holds them', async () => {
    await withAccess(async ({ settings, accessManager }) => {
      await store(settings, { rules: [rule('ro', { appliesToAdmins: true })] });

      const info = await access(accessManager, ADMIN);

      expect(info.canAccess).toBe(true);
      expect(info.canWrite).toBe(false);
      expect(info.canDelete).toBe(false);
      expect(info.canUpload).toBe(false);
      expect(info.canCreateFolder).toBe(false);
      expect(info.canCreateFile).toBe(false);
    });
  });

  /** The behaviour from the report, unchanged for a rule that says nothing. */
  it('still lets an administrator write where a plain read-only rule stands', async () => {
    await withAccess(async ({ settings, accessManager }) => {
      await store(settings, { rules: [rule('ro')] });

      expect((await access(accessManager, ADMIN)).canWrite).toBe(true);
      expect((await access(accessManager, REGULAR)).canWrite).toBe(false);
    });
  });

  it('refuses the folder to an administrator a hidden rule holds', async () => {
    await withAccess(async ({ settings, accessManager }) => {
      await store(settings, { rules: [rule('hidden', { appliesToAdmins: true })] });

      expect((await access(accessManager, ADMIN)).canAccess).toBe(false);
    });
  });

  it('shows an administrator a folder hidden from everybody else', async () => {
    await withAccess(async ({ settings, accessManager }) => {
      await store(settings, { rules: [rule('hidden', { appliesToAdmins: false })] });

      expect((await access(accessManager, ADMIN)).canAccess).toBe(true);
      expect((await access(accessManager, REGULAR)).canAccess).toBe(false);
    });
  });
});
