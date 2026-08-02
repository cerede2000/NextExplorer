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
});
