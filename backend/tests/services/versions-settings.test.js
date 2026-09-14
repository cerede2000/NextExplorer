import { afterEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The file version settings: on by default, everything for a day, one an hour
 * for a week, one a day for a month, fifty per file, a checkpoint every ten
 * minutes of an editing session — the environment can change the defaults, an
 * administrator what is in force, and nothing out of order can be stored.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const build = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'versions-settings-', env });
  return envContext.requireFresh('src/services/settingsService');
};

describe('the defaults', () => {
  it('are the compact retention the design settled on', async () => {
    const settingsService = await build();

    expect((await settingsService.getSystemSettings()).versions).toEqual({
      enabled: true,
      keepAllHours: 24,
      hourlyDays: 7,
      dailyDays: 30,
      maxPerFile: 50,
      sessionCheckpointMinutes: 10,
    });
  });

  it('come from the environment when it sets them', async () => {
    const settingsService = await build({
      VERSIONS_ENABLED: 'false',
      VERSIONS_KEEP_ALL_HOURS: '48',
      VERSIONS_HOURLY_DAYS: '14',
      VERSIONS_DAILY_DAYS: '90',
      VERSIONS_MAX_PER_FILE: '500',
      VERSIONS_SESSION_CHECKPOINT_MINUTES: '5',
    });

    expect((await settingsService.getSystemSettings()).versions).toEqual({
      enabled: false,
      keepAllHours: 48,
      hourlyDays: 14,
      dailyDays: 90,
      maxPerFile: 500,
      sessionCheckpointMinutes: 5,
    });
  });

  it('fall back rather than fail on values that make no sense', async () => {
    const settingsService = await build({
      VERSIONS_MAX_PER_FILE: 'lots',
      VERSIONS_DAILY_DAYS: '0',
    });

    expect((await settingsService.getSystemSettings()).versions).toMatchObject({
      maxPerFile: 50,
      dailyDays: 30,
    });
  });

  it('are independent of the trash: one can be on without the other', async () => {
    const settingsService = await build({ TRASH_ENABLED: 'false' });

    const settings = await settingsService.getSystemSettings();
    expect(settings.trash.enabled).toBe(false);
    expect(settings.versions.enabled).toBe(true);
  });
});

describe('what may be stored', () => {
  it('keeps every value within its bounds', async () => {
    const settingsService = await build();

    expect(
      settingsService.sanitizeVersions({
        keepAllHours: 0,
        maxPerFile: 100000,
        sessionCheckpointMinutes: -1,
      })
    ).toMatchObject({ keepAllHours: 1, maxPerFile: 1000, sessionCheckpointMinutes: 1 });
  });

  it('keeps the tiers in order', async () => {
    const settingsService = await build();

    expect(
      settingsService.sanitizeVersions({ keepAllHours: 72, hourlyDays: 1, dailyDays: 2 })
    ).toMatchObject({ keepAllHours: 72, hourlyDays: 3, dailyDays: 3 });
  });

  it('is what is read back after an administrator saves it', async () => {
    const settingsService = await build();

    await settingsService.setSystemSetting('system', 'versions', {
      enabled: false,
      maxPerFile: 12,
    });

    expect((await settingsService.getSystemSettings()).versions).toMatchObject({
      enabled: false,
      maxPerFile: 12,
      keepAllHours: 24,
    });
  });
});
