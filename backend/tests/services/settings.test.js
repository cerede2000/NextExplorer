import { describe, it, expect } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

const SETTINGS_MODULES = [
  'src/services/storage/jsonStorage',
  'src/services/settingsService',
  'src/services/db',
];

const createSettingsContext = async () => {
  const envContext = await setupTestEnv({
    tag: 'settings-test-',
    modules: SETTINGS_MODULES,
  });
  const settingsService = envContext.requireFresh('src/services/settingsService');
  return { envContext, settingsService };
};

describe('Settings Service', () => {
  describe('getSettings', () => {
    it('should return defaults when no config exists', async () => {
      const { envContext, settingsService } = await createSettingsContext();
      try {
        const settings = await settingsService.getSettings();

        expect(settings.access.rules).toEqual([]);
        expect(settings.thumbnails.enabled).toBe(true);
        expect(settings.thumbnails.size).toBe(200);
        expect(settings.thumbnails.quality).toBe(70);
        expect(settings.thumbnails.concurrency).toBe(10);
        expect(settings.uploads.chunkedEnabled).toBe(false);
        expect(settings.uploads.chunkSizeBytes).toBe(8 * 1024 * 1024);
      } finally {
        await envContext.cleanup();
      }
    });
  });

  describe('setSettings', () => {
    it('should sanitize thumbnails and filter access rules', async () => {
      const { envContext, settingsService } = await createSettingsContext();
      try {
        const payload = {
          thumbnails: { size: 5000, quality: 150, concurrency: -2 },
          access: {
            rules: [
              { path: '/Projects', permissions: 'ro', recursive: true },
              { path: 'uploads', permissions: 'invalid', recursive: false },
              { path: '../bad', permissions: 'hidden' },
            ],
          },
          uploads: { chunkedEnabled: true, chunkSizeBytes: 512 },
        };

        const updated = await settingsService.setSettings(payload);

        expect(updated.thumbnails.size).toBe(1024);
        expect(updated.thumbnails.quality).toBe(100);
        expect(updated.thumbnails.concurrency).toBe(1);
        expect(updated.thumbnails.enabled).toBe(true);
        expect(updated.access.rules.length).toBe(2);
        expect(updated.access.rules[0].path).toBe('Projects');
        expect(updated.access.rules[1].permissions).toBe('rw');
        expect(updated.uploads.chunkedEnabled).toBe(true);
        expect(updated.uploads.chunkSizeBytes).toBe(1024 * 1024);
      } finally {
        await envContext.cleanup();
      }
    });
  });
});
