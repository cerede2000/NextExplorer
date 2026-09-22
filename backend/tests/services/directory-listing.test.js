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

/**
 * The mark that says a rule holds this entry to reading.
 *
 * A rule was invisible until somebody tried to write in the folder it covers,
 * and on an account it did not hold it was never refused at all
 * (nxzai/NextExplorer#407). The listing says it up front — where the
 * restriction begins, and only to the accounts the rule actually holds.
 */
describe('the read-only mark on a listed entry', () => {
  let env;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  const listWith = async ({ rules, applyToAdmins = false, roles = ['admin'], dir = '' }) => {
    const created = await createContext();
    env = created.envContext;
    await fs.mkdir(path.join(env.volumeDir, 'Team', 'Sub'), { recursive: true });
    await fs.mkdir(path.join(env.volumeDir, 'Open'), { recursive: true });
    await fs.writeFile(path.join(env.volumeDir, 'Team', 'note.txt'), 'note');

    return created.listDirectoryItems({
      absoluteDir: path.join(env.volumeDir, dir),
      parentLogicalPath: dir,
      context: { user: { id: 'u1', roles } },
      thumbsEnabled: false,
      access: { rules, applyToAdmins },
    });
  };

  const marks = (items) =>
    Object.fromEntries(items.map((item) => [item.name, item.readOnly ?? null]));

  const READ_ONLY_TEAM = [
    { path: 'Team', recursive: true, permissions: 'ro', appliesToAdmins: true },
  ];

  it('marks the folder a rule holds, and leaves the others alone', async () => {
    expect(marks(await listWith({ rules: READ_ONLY_TEAM }))).toEqual({
      Team: 'access',
      Open: null,
    });
  });

  /** Inside it everything is read-only; a lock on every row would say nothing. */
  it('draws nothing inside that folder, where the restriction already holds', async () => {
    expect(marks(await listWith({ rules: READ_ONLY_TEAM, dir: 'Team' }))).toEqual({
      Sub: null,
      'note.txt': null,
    });
  });

  it('draws nothing for an account the rule does not hold', async () => {
    const rules = [{ path: 'Team', recursive: true, permissions: 'ro', appliesToAdmins: false }];

    expect(marks(await listWith({ rules }))).toEqual({ Team: null, Open: null });
    expect(marks(await listWith({ rules, roles: ['user'] }))).toEqual({
      Team: 'access',
      Open: null,
    });
  });

  it('draws it for an administrator once the setting holds them to every rule', async () => {
    const rules = [{ path: 'Team', recursive: true, permissions: 'ro', appliesToAdmins: false }];

    expect(marks(await listWith({ rules, applyToAdmins: true }))).toEqual({
      Team: 'access',
      Open: null,
    });
  });

  it('draws nothing when no rule is in force', async () => {
    expect(marks(await listWith({ rules: [] }))).toEqual({ Team: null, Open: null });
  });
});

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
    await fs.writeFile(path.join(envContext.volumeDir, '.env'), 'secret');
    await fs.mkdir(path.join(envContext.volumeDir, '.cache'));

    const items = await listDirectoryItems({
      absoluteDir: envContext.volumeDir,
      parentLogicalPath: '',
      context: { user: { id: 'admin', roles: ['admin'] } },
      thumbsEnabled: false,
    });

    expect(items.map((item) => item.name).sort()).toEqual(['visible.txt']);
  });

  it('treats temporary download artifacts as configurable hidden files', async () => {
    const { envContext, listDirectoryItems } = await createContext();
    currentEnv = envContext;

    await fs.writeFile(path.join(envContext.volumeDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(envContext.volumeDir, 'video.mkv.download'), 'temporary');

    const hiddenItems = await listDirectoryItems({
      absoluteDir: envContext.volumeDir,
      parentLogicalPath: '',
      context: { user: { id: 'admin', roles: ['admin'] } },
      thumbsEnabled: false,
    });
    expect(hiddenItems.map((item) => item.name)).toEqual(['visible.txt']);

    const allItems = await listDirectoryItems({
      absoluteDir: envContext.volumeDir,
      parentLogicalPath: '',
      context: { user: { id: 'admin', roles: ['admin'] } },
      thumbsEnabled: false,
      includeHiddenFiles: true,
    });
    expect(allItems.map((item) => item.name).sort()).toEqual(['video.mkv.download', 'visible.txt']);
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
