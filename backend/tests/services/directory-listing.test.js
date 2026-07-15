import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

const createContext = async (env = {}) => {
  const envContext = await setupTestEnv({
    tag: 'directory-listing-test-',
    env,
    modules: [
      'src/config/env',
      'src/config/index',
      'src/services/accessManager',
      'src/services/directoryListingService',
    ],
  });

  const { listDirectoryItems } = envContext.requireFresh('src/services/directoryListingService');
  return { envContext, listDirectoryItems };
};

describe('Directory listing service', () => {
  let currentEnv;

  afterEach(async () => {
    if (currentEnv) {
      await currentEnv.cleanup();
      currentEnv = null;
    }
  });

  it('hides dot-prefixed entries by default', async () => {
    const { envContext, listDirectoryItems } = await createContext();
    currentEnv = envContext;

    await fs.writeFile(path.join(envContext.volumeDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(envContext.volumeDir, 'visible.txt.download'), 'partial');
    await fs.writeFile(path.join(envContext.volumeDir, '.env'), 'secret');
    await fs.mkdir(path.join(envContext.volumeDir, '.cache'));

    const items = await listDirectoryItems({
      absoluteDir: envContext.volumeDir,
      parentLogicalPath: '',
      context: { user: { id: 'admin', roles: ['admin'] } },
      thumbsEnabled: false,
    });

    expect(items.map((item) => item.name).sort()).toEqual(['visible.txt']);

    const allItems = await listDirectoryItems({
      absoluteDir: envContext.volumeDir,
      parentLogicalPath: '',
      context: { user: { id: 'admin', roles: ['admin'] } },
      thumbsEnabled: false,
      includeHiddenFiles: true,
    });
    expect(allItems.map((item) => item.name).sort()).toEqual([
      '.cache',
      '.env',
      'visible.txt',
      'visible.txt.download',
    ]);
  });

  it('hides configured prefix patterns', async () => {
    const { envContext, listDirectoryItems } = await createContext({
      HIDDEN_FILE_PATTERNS: '.,@',
    });
    currentEnv = envContext;

    await fs.writeFile(path.join(envContext.volumeDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(envContext.volumeDir, '@SynologyWorkingFile'), 'hidden');
    await fs.mkdir(path.join(envContext.volumeDir, '@eaDir'));

    const items = await listDirectoryItems({
      absoluteDir: envContext.volumeDir,
      parentLogicalPath: '',
      context: { user: { id: 'admin', roles: ['admin'] } },
      thumbsEnabled: false,
    });

    expect(items.map((item) => item.name)).toEqual(['visible.txt']);
  });

  it('shows configured hidden patterns when requested', async () => {
    const { envContext, listDirectoryItems } = await createContext({
      HIDDEN_FILE_PATTERNS: '.,@',
    });
    currentEnv = envContext;

    await fs.writeFile(path.join(envContext.volumeDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(envContext.volumeDir, '.test'), 'hidden');
    await fs.mkdir(path.join(envContext.volumeDir, '@eaDir'));

    const items = await listDirectoryItems({
      absoluteDir: envContext.volumeDir,
      parentLogicalPath: '',
      context: { user: { id: 'admin', roles: ['admin'] } },
      thumbsEnabled: false,
      includeHiddenFiles: true,
    });

    expect(items.map((item) => item.name).sort()).toEqual(['.test', '@eaDir', 'visible.txt']);
  });
});
