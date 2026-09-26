import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The trash settings: on by default, thirty days, a tenth of a volume — the
 * environment can change the defaults, an administrator can change what is in
 * force, and nobody can store a value the trash cannot work with.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const build = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'trash-settings-', env });
  return envContext.requireFresh('src/services/settingsService');
};

describe('the defaults', () => {
  it('are on, thirty days, a tenth of the volume, and no size cap', async () => {
    const settingsService = await build();

    expect((await settingsService.getSystemSettings()).trash).toEqual({
      enabled: true,
      retentionDays: 30,
      maxPercent: 10,
      maxBytes: null,
    });
  });

  it('come from the environment when it sets them', async () => {
    const settingsService = await build({
      TRASH_ENABLED: 'false',
      TRASH_RETENTION_DAYS: '7',
      TRASH_MAX_PERCENT: '25',
      TRASH_MAX_SIZE: '2G',
    });

    expect((await settingsService.getSystemSettings()).trash).toEqual({
      enabled: false,
      retentionDays: 7,
      maxPercent: 25,
      maxBytes: 2 * 1024 ** 3,
    });
  });

  it('fall back rather than fail on values that make no sense', async () => {
    const settingsService = await build({ TRASH_RETENTION_DAYS: 'soon', TRASH_MAX_PERCENT: '0' });

    expect((await settingsService.getSystemSettings()).trash).toMatchObject({
      retentionDays: 30,
      maxPercent: 10,
    });
  });
});

describe('what may be stored', () => {
  it('keeps the retention and the share within bounds', async () => {
    const settingsService = await build();

    expect(settingsService.sanitizeTrash({ retentionDays: 0, maxPercent: 500 })).toMatchObject({
      retentionDays: 1,
      maxPercent: 90,
    });
    expect(settingsService.sanitizeTrash({ retentionDays: 99999, maxPercent: -3 })).toMatchObject({
      retentionDays: 3650,
      maxPercent: 1,
    });
  });

  it('removes the size cap on an explicit null, and keeps the default when the field is absent', async () => {
    const settingsService = await build({ TRASH_MAX_SIZE: '5G' });

    expect(settingsService.sanitizeTrash({ maxBytes: null }).maxBytes).toBeNull();
    expect(settingsService.sanitizeTrash({}).maxBytes).toBe(5 * 1024 ** 3);
    expect(settingsService.sanitizeTrash({ maxBytes: '1G' }).maxBytes).toBe(1024 ** 3);
  });

  it('keeps a stored change over the environment default', async () => {
    const settingsService = await build();
    await settingsService.setSystemSetting('system', 'trash', { retentionDays: 14 });

    expect((await settingsService.getSystemSettings()).trash.retentionDays).toBe(14);
  });
});

describe('changing them', () => {
  const buildApp = async (user) => {
    await build();
    const settingsRoutes = envContext.requireFresh('src/routes/settings');
    const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
    return createTestApp({ router: settingsRoutes, mountPath: '/api', user, errorHandler });
  };

  it('is for administrators, who get back what is now in force', async () => {
    const app = await buildApp({ id: 'admin', roles: ['admin'] });

    const response = await request(app)
      .patch('/api/settings')
      .send({ trash: { retentionDays: 60, maxPercent: 5, maxBytes: null, enabled: false } });

    expect(response.status).toBe(200);
    expect(response.body.trash).toEqual({
      enabled: false,
      retentionDays: 60,
      maxPercent: 5,
      maxBytes: null,
    });
  });

  it('merges a partial change over what is stored', async () => {
    const app = await buildApp({ id: 'admin', roles: ['admin'] });
    await request(app)
      .patch('/api/settings')
      .send({ trash: { retentionDays: 60 } });

    const response = await request(app)
      .patch('/api/settings')
      .send({ trash: { maxPercent: 20 } });

    expect(response.body.trash).toMatchObject({ retentionDays: 60, maxPercent: 20 });
  });

  it('is refused to everyone else, with nothing written', async () => {
    const app = await buildApp({ id: 'user', roles: ['user'] });

    const response = await request(app)
      .patch('/api/settings')
      .send({ trash: { enabled: false } });

    expect(response.status).toBe(403);
    const settingsService = envContext.requireFresh('src/services/settingsService');
    expect((await settingsService.getSystemSettings()).trash.enabled).toBe(true);
  });
});

describe('what the public features say', () => {
  it('whether deleting goes to the trash, and for how long', async () => {
    await build({ TRASH_RETENTION_DAYS: '45' });
    const featuresRoutes = envContext.requireFresh('src/routes/features');
    const app = createTestApp({ router: featuresRoutes, mountPath: '/api' });

    const response = await request(app).get('/api/features');

    expect(response.body.trash).toEqual({ enabled: true, retentionDays: 45 });
  });
});
