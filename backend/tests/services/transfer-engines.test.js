import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The same promises, kept by both engines.
 *
 * Copying and deleting have two implementations — `rsync` and `rm` on one side,
 * streams and `fs.rm` on the other — and which one runs used to be decided by
 * the platform, at the moment the module loaded. Each was then only ever
 * exercised where it was chosen: the native path could not run on a developer's
 * macOS machine, and the JavaScript path could not run on the Linux that CI
 * runs. Nobody ran both, and nothing named the setting: `FILE_TRANSFER_ENGINE`
 * appeared once in the whole repository, in the line that read it.
 *
 * The engine is asked for now rather than assumed, so these run the same facts
 * through both. Where they disagree, one of them is wrong — and the point of
 * writing them side by side is that the disagreement is visible rather than
 * dependent on who ran the suite.
 *
 * `rm -rf` is what the native delete is, spawned detached. Thirty lines of it
 * had never been executed by a test on any machine that measured coverage.
 */

let currentEnv;

const ENGINES = ['native', 'stream'];

const setup = async (engine) => {
  currentEnv = await setupTestEnv({
    tag: `transfer-${engine}-`,
    env: { FILE_TRANSFER_ENGINE: engine },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/services/fileTransferService',
      'src/services/accessManager',
      'src/utils/pathUtils',
    ],
  });

  const service = currentEnv.requireFresh('src/services/fileTransferService');
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
  ).run(now, now);

  return { service, volume: currentEnv.volumeDir, user: { id: 'admin', roles: ['admin'] } };
};

/** A folder with something in it, and something in a folder inside it. */
const seedTree = async (volume, name) => {
  const root = path.join(volume, name);
  await fs.mkdir(path.join(root, 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'top.txt'), 'top');
  await fs.writeFile(path.join(root, 'nested', 'deep.txt'), 'deep');
  return root;
};

const exists = async (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

describe.each(ENGINES)('the %s engine', (engine) => {
  it('is the one that was asked for', async () => {
    const { service } = await setup(engine);

    expect(service.nativeTransferEnabled()).toBe(engine === 'native');
  });

  it('reports which one it is running', async () => {
    const { service } = await setup(engine);

    expect(service.getDiagnosticsSnapshot().nativeTransferEnabled).toBe(engine === 'native');
  });

  it('deletes a folder and everything under it', async () => {
    const { service, volume, user } = await setup(engine);
    const root = await seedTree(volume, 'Doomed');

    await service.deleteItems([{ path: '', name: 'Doomed' }], { user });

    expect(await exists(root)).toBe(false);
  });

  it('deletes a single file', async () => {
    const { service, volume, user } = await setup(engine);
    await fs.writeFile(path.join(volume, 'note.txt'), 'gone soon');

    await service.deleteItems([{ path: '', name: 'note.txt' }], { user });

    expect(await exists(path.join(volume, 'note.txt'))).toBe(false);
  });

  it('leaves what it was not asked to delete', async () => {
    const { service, volume, user } = await setup(engine);
    await seedTree(volume, 'Doomed');
    await seedTree(volume, 'Spared');

    await service.deleteItems([{ path: '', name: 'Doomed' }], { user });

    expect(await exists(path.join(volume, 'Spared', 'nested', 'deep.txt'))).toBe(true);
  });

  it('says what it deleted', async () => {
    const { service, volume, user } = await setup(engine);
    await seedTree(volume, 'Doomed');

    const results = await service.deleteItems([{ path: '', name: 'Doomed' }], { user });

    expect(results).toEqual([expect.objectContaining({ status: 'deleted' })]);
  });

  /**
   * A name beginning with a dash is an option to a command line and a filename
   * to everybody else. The native path passes `--` before the path for exactly
   * this; the JavaScript one never had the problem.
   */
  it('deletes a folder whose name looks like an option', async () => {
    const { service, volume, user } = await setup(engine);
    const root = await seedTree(volume, '-rf-trap');

    await service.deleteItems([{ path: '', name: '-rf-trap' }], { user });

    expect(await exists(root)).toBe(false);
  });

  it('copies a folder with everything under it', async () => {
    const { service, volume, user } = await setup(engine);
    await seedTree(volume, 'Source');
    await fs.mkdir(path.join(volume, 'Target'), { recursive: true });

    const prep = await service.prepareTransfer(
      [{ path: '', name: 'Source' }],
      'Target',
      'copy',
      { user }
    );
    await service.executeTransfer(prep, 'copy', undefined, { user });

    expect(await exists(path.join(volume, 'Target', 'Source', 'nested', 'deep.txt'))).toBe(true);
  });

  it('leaves the original where it was when copying', async () => {
    const { service, volume, user } = await setup(engine);
    await seedTree(volume, 'Source');
    await fs.mkdir(path.join(volume, 'Target'), { recursive: true });

    const prep = await service.prepareTransfer(
      [{ path: '', name: 'Source' }],
      'Target',
      'copy',
      { user }
    );
    await service.executeTransfer(prep, 'copy', undefined, { user });

    expect(await exists(path.join(volume, 'Source', 'top.txt'))).toBe(true);
  });

  it('copies the contents of a file, not just its name', async () => {
    const { service, volume, user } = await setup(engine);
    await fs.writeFile(path.join(volume, 'note.txt'), 'the actual bytes');
    await fs.mkdir(path.join(volume, 'Target'), { recursive: true });

    const prep = await service.prepareTransfer(
      [{ path: '', name: 'note.txt' }],
      'Target',
      'copy',
      { user }
    );
    await service.executeTransfer(prep, 'copy', undefined, { user });

    expect(await fs.readFile(path.join(volume, 'Target', 'note.txt'), 'utf8')).toBe(
      'the actual bytes'
    );
  });

  it('moves a folder rather than leaving it behind', async () => {
    const { service, volume, user } = await setup(engine);
    await seedTree(volume, 'Source');
    await fs.mkdir(path.join(volume, 'Target'), { recursive: true });

    const prep = await service.prepareTransfer(
      [{ path: '', name: 'Source' }],
      'Target',
      'move',
      { user }
    );
    await service.executeTransfer(prep, 'move', undefined, { user });

    expect(await exists(path.join(volume, 'Target', 'Source', 'top.txt'))).toBe(true);
    expect(await exists(path.join(volume, 'Source'))).toBe(false);
  });

  /** Nothing to do is the caller's mistake, whichever engine would have done it. */
  it('refuses a transfer with no items', async () => {
    const { service, user } = await setup(engine);

    await expect(
      service.prepareTransfer([], 'Target', 'copy', { user })
    ).rejects.toThrow(/at least one item/i);
  });

  it('refuses a delete that was cancelled before it began', async () => {
    const { service, volume, user } = await setup(engine);
    await seedTree(volume, 'Doomed');
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.deleteItems([{ path: '', name: 'Doomed' }], { user, signal: controller.signal })
    ).rejects.toThrow();
  });

  it('leaves the folder alone when the delete was cancelled before it began', async () => {
    const { service, volume, user } = await setup(engine);
    const root = await seedTree(volume, 'Doomed');
    const controller = new AbortController();
    controller.abort();

    await service
      .deleteItems([{ path: '', name: 'Doomed' }], { user, signal: controller.signal })
      .catch(() => {});

    expect(await exists(root)).toBe(true);
  });
});

/**
 * When the native tool cannot be used at all.
 *
 * `--info=progress2` arrived in rsync 3.1. RHEL 7 ships 3.0.9 and macOS ships
 * 2.6.9, and on either of those every copy failed with a raw usage error while
 * a working implementation sat unused in the same file. The setting documented
 * for exactly that case only helped somebody who already knew to reach for it,
 * after their copies had failed.
 *
 * The distinction these pin is the one that makes falling back safe: a tool
 * that could not start has written nothing, so the other implementation can
 * begin cleanly. A tool that failed partway has written something, and
 * resuming over it is not a recovery.
 */
describe('deciding whether a native tool is unusable', () => {
  let isUnusable;

  const load = async () => {
    if (!isUnusable) {
      const { service } = await setup('stream');
      isUnusable = service.nativeToolIsUnusable;
    }
    return isUnusable;
  };

  it('says so when the binary is not installed', async () => {
    const decide = await load();

    expect(decide({ code: 'ENOENT', message: 'spawn rsync ENOENT' })).toBe(true);
  });

  it('says so when the tool is too old to understand the request', async () => {
    const decide = await load();

    expect(decide({ stderr: "rsync: unrecognized option `--info=progress2'" })).toBe(true);
  });

  it('accepts the other wordings the same refusal comes in', async () => {
    const decide = await load();

    expect(decide({ stderr: 'unknown option -- info' })).toBe(true);
    expect(decide({ stderr: 'illegal option -- x' })).toBe(true);
  });

  /**
   * The permission failure that a restricted ZFS dataset produces is a real
   * attempt that got partway, and it already has its own retry. Reading it as
   * "unusable" would throw away that handling and copy the tree twice.
   */
  it('does not say so for a destination that refused a chmod', async () => {
    const decide = await load();

    expect(decide({ exitCode: 23, stderr: 'rsync: failed to set permissions on ...' })).toBe(false);
  });

  it('does not say so for a failure partway through', async () => {
    const decide = await load();

    expect(decide({ exitCode: 11, stderr: 'rsync: write failed: No space left on device' })).toBe(
      false
    );
  });

  it('does not say so for an error carrying nothing to go on', async () => {
    const decide = await load();

    expect(decide({})).toBe(false);
    expect(decide(null)).toBe(false);
  });
});
