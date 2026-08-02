import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Path containment used to be a pure string comparison, so a symbolic link
 * planted inside the volume (an archive can carry one) pointed anywhere while
 * still looking contained. These pin both halves: links inside are refused,
 * and a volume root that is itself a link still works — which is the normal
 * setup on a NAS and what a naive realpath check would break.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

describe('Volume path containment', () => {
  it('refuses a path that escapes through a symbolic link', async () => {
    const env = await setupTestEnv({
      tag: 'containment-symlink-',
      modules: ['src/config/env', 'src/config/index', 'src/utils/pathUtils'],
    });
    currentEnv = env;

    const outside = path.join(env.tmpRoot, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await fs.symlink(outside, path.join(env.volumeDir, 'escape'));

    const { resolveVolumePath } = env.requireFresh('src/utils/pathUtils');

    // The lexical check passes (the string starts with the volume root), so
    // only the real-path check can catch this.
    expect(() => resolveVolumePath('escape/secret.txt')).toThrow(/outside the configured volume/i);
    expect(() => resolveVolumePath('escape')).toThrow(/outside the configured volume/i);
  });

  it('still resolves normal paths, including ones not created yet', async () => {
    const env = await setupTestEnv({
      tag: 'containment-normal-',
      modules: ['src/config/env', 'src/config/index', 'src/utils/pathUtils'],
    });
    currentEnv = env;

    await fs.mkdir(path.join(env.volumeDir, 'docs'), { recursive: true });
    const { resolveVolumePath } = env.requireFresh('src/utils/pathUtils');

    expect(resolveVolumePath('docs')).toContain('docs');
    // A file about to be created must resolve through its existing parent.
    expect(resolveVolumePath('docs/new-file.txt')).toContain('new-file.txt');
    expect(resolveVolumePath('brand/new/tree.txt')).toContain('tree.txt');
  });

  it('accepts a volume root that is itself a symbolic link', async () => {
    const env = await setupTestEnv({
      tag: 'containment-linked-root-',
      modules: ['src/config/env', 'src/config/index', 'src/utils/pathUtils'],
    });
    currentEnv = env;

    // Mimic /mnt -> /volume1: point VOLUME_ROOT at a link to the real dir.
    const realStorage = path.join(env.tmpRoot, 'real-storage');
    await fs.mkdir(path.join(realStorage, 'media'), { recursive: true });
    const linkedRoot = path.join(env.tmpRoot, 'linked-root');
    await fs.symlink(realStorage, linkedRoot);

    process.env.VOLUME_ROOT = linkedRoot;
    try {
      const { resolveVolumePath } = env.requireFresh('src/utils/pathUtils');
      expect(() => resolveVolumePath('media')).not.toThrow();
    } finally {
      process.env.VOLUME_ROOT = env.volumeDir;
    }
  });

  it('refuses a broken symbolic link pointing outside', async () => {
    const env = await setupTestEnv({
      tag: 'containment-dangling-',
      modules: ['src/config/env', 'src/config/index', 'src/utils/pathUtils'],
    });
    currentEnv = env;

    // The target does not exist, so realpath fails on the link itself. Treating
    // that as "not created yet" and checking the parent instead would accept it
    // — and the next write would land in /etc.
    await fs.symlink(path.join(env.tmpRoot, 'nowhere', 'passwd'), path.join(env.volumeDir, 'dead'));
    const { resolveVolumePath } = env.requireFresh('src/utils/pathUtils');

    expect(() => resolveVolumePath('dead')).toThrow(/outside the configured volume/i);
    expect(() => resolveVolumePath('dead/child.txt')).toThrow(/outside the configured volume/i);
  });

  it('accepts a broken link whose target stays inside the volume', async () => {
    const env = await setupTestEnv({
      tag: 'containment-dangling-inside-',
      modules: ['src/config/env', 'src/config/index', 'src/utils/pathUtils'],
    });
    currentEnv = env;

    await fs.symlink(path.join(env.volumeDir, 'not-yet.txt'), path.join(env.volumeDir, 'pending'));
    const { resolveVolumePath } = env.requireFresh('src/utils/pathUtils');

    expect(() => resolveVolumePath('pending')).not.toThrow();
  });

  it('gives up on a symbolic link loop instead of spinning', async () => {
    const env = await setupTestEnv({
      tag: 'containment-loop-',
      modules: ['src/config/env', 'src/config/index', 'src/utils/pathUtils'],
    });
    currentEnv = env;

    await fs.symlink(path.join(env.volumeDir, 'b'), path.join(env.volumeDir, 'a'));
    await fs.symlink(path.join(env.volumeDir, 'a'), path.join(env.volumeDir, 'b'));
    const { resolveVolumePath } = env.requireFresh('src/utils/pathUtils');

    expect(() => resolveVolumePath('a')).toThrow(/symbolic links/i);
  });
});

/**
 * The volume was the only space whose containment survived a symbolic link.
 * A personal folder and an assigned user volume are just as reachable — the
 * archive that plants the link does not care which space it lands in.
 */
describe('Other spaces containment', () => {
  it('refuses an escape from a personal folder', async () => {
    const env = await setupTestEnv({
      tag: 'containment-personal-',
      env: { USER_DIR_ENABLED: 'true' },
      modules: ['src/config/env', 'src/config/index', 'src/utils/pathUtils'],
    });
    currentEnv = env;

    const { resolvePersonalPath } = env.requireFresh('src/utils/pathUtils');
    const user = { id: 'user-1', username: 'alice' };
    const userRoot = resolvePersonalPath('', user);
    await fs.mkdir(userRoot, { recursive: true });

    const outside = path.join(env.tmpRoot, 'outside-personal');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await fs.symlink(outside, path.join(userRoot, 'escape'));

    expect(() => resolvePersonalPath('escape/secret.txt', user)).toThrow(
      /outside the configured user directory/i
    );
    expect(() => resolvePersonalPath('docs/report.txt', user)).not.toThrow();
  });

  it('refuses an escape from an assigned user volume', async () => {
    const env = await setupTestEnv({
      tag: 'containment-user-volume-',
      modules: ['src/config/env', 'src/config/index', 'src/utils/pathUtils'],
    });
    currentEnv = env;

    const assigned = path.join(env.tmpRoot, 'assigned');
    await fs.mkdir(assigned, { recursive: true });
    const outside = path.join(env.tmpRoot, 'outside-assigned');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await fs.symlink(outside, path.join(assigned, 'escape'));

    const { resolveLogicalPath } = env.requireFresh('src/utils/pathUtils');
    const userVolume = { id: 'vol-1', userId: 'user-1', label: 'Work', path: assigned };

    await expect(
      resolveLogicalPath('Work/escape/secret.txt', { user: { id: 'user-1' }, userVolume })
    ).rejects.toThrow(/outside the assigned volume/i);
  });
});
