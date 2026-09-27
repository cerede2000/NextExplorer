import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * A ZFS dataset with `aclmode=restricted` refuses the chmod that `rsync -a`
 * performs after writing a file, because new files there must inherit the
 * directory's ACL untouched (nxzai/NextExplorer#367). rsync copies the contents
 * correctly and only then fails with exit 23.
 *
 * That cannot be reproduced on a test machine, so rsync is replaced by a script
 * that behaves the way rsync does there: it copies, records the arguments it
 * was given, and refuses to set permissions unless told not to try.
 */
const RSYNC_STUB = `#!/bin/sh
echo "$@" >> "$RSYNC_ARGS_LOG"
case "$@" in
  *--no-perms*)
    exit 0
    ;;
  *)
    echo 'rsync: [receiver] failed to set permissions on "/mnt/dest/file": Operation not permitted (1)' >&2
    exit 23
    ;;
esac
`;

/** An exit 23 that has nothing to do with permissions must not be retried. */
const RSYNC_STUB_OTHER_FAILURE = `#!/bin/sh
echo "$@" >> "$RSYNC_ARGS_LOG"
echo 'rsync: [sender] link_stat "/mnt/src/gone" failed: No such file or directory (2)' >&2
exit 23
`;

let tmpDir;
let originalPath;
let originalPreserve;

const installFakeRsync = async (script) => {
  const binDir = path.join(tmpDir, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const rsyncPath = path.join(binDir, 'rsync');
  await fs.writeFile(rsyncPath, script, { mode: 0o755 });
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.RSYNC_ARGS_LOG = path.join(tmpDir, 'args.log');
};

const argsLog = async () => {
  const raw = await fs.readFile(process.env.RSYNC_ARGS_LOG, 'utf8').catch(() => '');
  return raw.trim().split('\n').filter(Boolean);
};

const loadService = () => {
  delete require.cache[require.resolve('../../src/config/env')];
  delete require.cache[require.resolve('../../src/services/fileTransferService')];
  return require('../../src/services/fileTransferService');
};

describe('copying where the destination refuses a chmod', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-acl-test-'));
    originalPath = process.env.PATH;
    originalPreserve = process.env.COPY_PRESERVE_PERMISSIONS;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalPreserve === undefined) delete process.env.COPY_PRESERVE_PERMISSIONS;
    else process.env.COPY_PRESERVE_PERMISSIONS = originalPreserve;
    delete process.env.RSYNC_ARGS_LOG;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('deciding whether to try again', () => {
    it('recognises a refused chmod', () => {
      const { isPermissionPreservationFailure } = loadService();

      expect(
        isPermissionPreservationFailure(
          23,
          'rsync: [receiver] failed to set permissions on "/mnt/x": Operation not permitted (1)'
        )
      ).toBe(true);
    });

    // Exit 23 covers far more than permissions — a source file that vanished
    // mid-copy gets the same code, and retrying without -p would not help.
    it('leaves any other partial failure alone', () => {
      const { isPermissionPreservationFailure } = loadService();

      expect(
        isPermissionPreservationFailure(23, 'link_stat "/mnt/gone" failed: No such file (2)')
      ).toBe(false);
      expect(isPermissionPreservationFailure(1, 'failed to set permissions')).toBe(false);
      expect(isPermissionPreservationFailure(0, '')).toBe(false);
      expect(isPermissionPreservationFailure(23, undefined)).toBe(false);
    });
  });

  describe('the default: preserve, and fall back only where it is refused', () => {
    it('copies again without preserving permissions', async () => {
      await installFakeRsync(RSYNC_STUB);
      const { copyWithNativeRsync } = loadService();

      await expect(copyWithNativeRsync('/src/file', '/dest/file')).resolves.toBeUndefined();

      const calls = await argsLog();
      expect(calls).toHaveLength(2);
      // Preserving is still what is attempted first.
      expect(calls[0]).not.toContain('--no-perms');
      expect(calls[1]).toContain('--no-perms');
    });

    it('gives up on a failure that copying differently cannot fix', async () => {
      await installFakeRsync(RSYNC_STUB_OTHER_FAILURE);
      const { copyWithNativeRsync } = loadService();

      await expect(copyWithNativeRsync('/src/file', '/dest/file')).rejects.toThrow(/link_stat/);

      // One attempt, not two: nothing here suggests a second would do better.
      expect(await argsLog()).toHaveLength(1);
    });
  });

  describe('the permanent mode', () => {
    // Where every copy would fail the same way, paying for a doomed attempt and
    // a retry each time is waste.
    it('never attempts to preserve permissions', async () => {
      process.env.COPY_PRESERVE_PERMISSIONS = 'false';
      await installFakeRsync(RSYNC_STUB);
      const { copyWithNativeRsync } = loadService();

      await expect(copyWithNativeRsync('/src/file', '/dest/file')).resolves.toBeUndefined();

      const calls = await argsLog();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('--no-perms');
    });
  });
});
