import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Sizes measured in one mode, read in the other.
 *
 * `shallow` counts a folder's own entries and `full` everything under it, so a
 * size measured one way is not stale in the other, it is wrong. Nothing
 * recorded which mode an index was built in, and the baseline skips itself as
 * soon as the volume holds any rows — so changing FOLDER_SIZE_MODE and
 * restarting went on showing every size from before, for good.
 *
 * It mattered little while the mode lived in a file nobody edits twice. Now
 * that Settings can move it without a restart (#9), the index writes down the
 * mode it measured in, and a start in another one measures again.
 */

const MODULES = [
  'src/config/env',
  'src/config/index',
  'src/services/indexDb',
  'src/services/folderSizeIndex',
  'src/services/folderSizeIndexer',
  'src/services/folderSizeManager',
];

let env = null;

afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

/** A folder holding one small file directly and one large one further down. */
const plant = async (volumeDir) => {
  const top = path.join(volumeDir, 'Docs', 'Project');
  await fs.mkdir(path.join(top, 'deep'), { recursive: true });
  await fs.writeFile(path.join(top, 'note.txt'), Buffer.alloc(100));
  await fs.writeFile(path.join(top, 'deep', 'video.bin'), Buffer.alloc(50_000));
  return top;
};

const sizeOf = async (absolutePath) => {
  const { getIndexDb } = env.requireFresh('src/services/indexDb');
  const index = env.requireFresh('src/services/folderSizeIndex');
  return index.getByAbsolutePath(await getIndexDb(), absolutePath)?.sizeBytes ?? null;
};

describe('a folder size index built in one mode and started in another', () => {
  it('measures again rather than keep the other mode’s sizes', async () => {
    env = await setupTestEnv({
      tag: 'folder-size-mode-',
      modules: MODULES,
      env: { FOLDER_SIZE_MODE: 'full' },
    });
    const project = await plant(env.volumeDir);

    const config = env.requireFresh('src/config/index');
    const manager = env.requireFresh('src/services/folderSizeManager');

    await manager.start();
    const full = await sizeOf(project);
    // Everything under it: the large file two levels down is counted.
    expect(full).toBeGreaterThanOrEqual(50_100);

    await manager.stop();
    // What a Settings change does, and what a restart with the other value in
    // the environment amounts to.
    config.folderSize.mode = 'shallow';
    config.folderSize.enabled = true;
    await manager.start();

    const shallow = await sizeOf(project);
    // Its own entries only: the small file, not the large one below.
    expect(shallow).toBeLessThan(50_000);
    expect(shallow).not.toBe(full);
  });

  it('keeps an index built in the mode it is started in', async () => {
    // The rebuild is for a changed mode, not for every start: a walk over a
    // large volume is the most expensive thing this worker does.
    env = await setupTestEnv({
      tag: 'folder-size-mode-same-',
      modules: MODULES,
      env: { FOLDER_SIZE_MODE: 'full' },
    });
    const project = await plant(env.volumeDir);
    const manager = env.requireFresh('src/services/folderSizeManager');

    await manager.start();
    const first = await sizeOf(project);
    await manager.stop();

    // A file written behind its back: a new walk would count it, a kept index
    // would not until something told it.
    await fs.writeFile(path.join(project, 'deep', 'later.bin'), Buffer.alloc(9_000));
    await manager.start();

    expect(await sizeOf(project)).toBe(first);
  });
});
