import { describe, it, expect } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
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

/**
 * Through the route the settings page actually uses.
 *
 * The page saves the rules and the switch above them from two controls, and a
 * save that replaced the whole section would drop whichever half was not on
 * the wire: tick the switch, save, and the rules are gone. The service's own
 * merge is proven above; this is the other caller, and it has a merge of its
 * own.
 */
describe('saving from the settings page', () => {
  const patch = async (env, body) => {
    const routes = env.requireFresh('src/routes/settings');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = ADMIN;
      next();
    });
    app.use('/api', routes);
    app.use(errorHandler);
    const response = await request(app).patch('/api/settings').send(body);
    expect(response.status).toBe(200);
    return response.body;
  };

  it('keeps the rules when only the switch is saved', async () => {
    await withAccess(async ({ env, settings }) => {
      await store(settings, { rules: [rule('ro')], applyToAdmins: false });

      const body = await patch(env, { access: { applyToAdmins: true } });

      expect(body.access.applyToAdmins).toBe(true);
      expect(body.access.rules).toHaveLength(1);
      expect((await settings.getSystemSettings()).access.rules).toHaveLength(1);
    });
  });

  it('keeps the switch when only the rules are saved', async () => {
    await withAccess(async ({ env, settings }) => {
      await store(settings, { rules: [rule('ro')], applyToAdmins: true });

      const body = await patch(env, { access: { rules: [rule('hidden')] } });

      expect(body.access.applyToAdmins).toBe(true);
      expect(body.access.rules[0].permissions).toBe('hidden');
    });
  });

  it('writes down whether each rule holds administrators', async () => {
    await withAccess(async ({ env, settings }) => {
      const body = await patch(env, {
        access: { rules: [rule('ro', { appliesToAdmins: true }), rule('hidden')] },
      });

      // A rule that says nothing keeps the reading it has always had, so an
      // upgrade moves nothing: hidden held them, read-only did not.
      expect(body.access.rules.map((r) => r.appliesToAdmins)).toEqual([true, true]);
      expect(
        (await settings.getSystemSettings()).access.rules.map((r) => r.appliesToAdmins)
      ).toEqual([true, true]);
    });
  });
});

/**
 * The sidebar and the home page.
 *
 * A `hidden` rule on a volume kept it out of the folder listing and refused it
 * by its address, and left its name in the sidebar for everybody — the one
 * place a hidden folder was most visible. The volumes are listed by a route of
 * their own, which never asked.
 */
describe('the volumes a person is offered', () => {
  const volumes = async (env, user) => {
    const routes = env.requireFresh('src/routes/volumes');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
    app.use('/api', routes);
    app.use(errorHandler);
    const response = await request(app).get('/api/volumes');
    expect(response.status).toBe(200);
    return response.body.map((volume) => volume.name);
  };

  it('leaves out one a rule hides from them', async () => {
    await withAccess(async ({ env, settings }) => {
      await fs.mkdir(path.join(env.volumeDir, 'Team'), { recursive: true });
      await fs.mkdir(path.join(env.volumeDir, 'Public'), { recursive: true });
      await store(settings, { rules: [rule('hidden')] });

      expect(await volumes(env, REGULAR)).toEqual(['Public']);
    });
  });

  it('keeps one a rule hides from everybody but them', async () => {
    await withAccess(async ({ env, settings }) => {
      await fs.mkdir(path.join(env.volumeDir, 'Team'), { recursive: true });
      await store(settings, { rules: [rule('hidden', { appliesToAdmins: false })] });

      expect(await volumes(env, ADMIN)).toEqual(['Team']);
      expect(await volumes(env, REGULAR)).toEqual([]);
    });
  });

  it('takes it away from an administrator the switch above the rules holds', async () => {
    await withAccess(async ({ env, settings }) => {
      await fs.mkdir(path.join(env.volumeDir, 'Team'), { recursive: true });
      await store(settings, {
        rules: [rule('hidden', { appliesToAdmins: false })],
        applyToAdmins: true,
      });

      expect(await volumes(env, ADMIN)).toEqual([]);
    });
  });

  it('leaves a read-only one where it is: it can be opened, only not written in', async () => {
    await withAccess(async ({ env, settings }) => {
      await fs.mkdir(path.join(env.volumeDir, 'Team'), { recursive: true });
      await store(settings, { rules: [rule('ro')] });

      expect(await volumes(env, REGULAR)).toEqual(['Team']);
    });
  });
});
