const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Whether the native copy can run here: an rsync that understands
 * `--info=progress2`, the flag the transfer service asks it for.
 *
 * The flag arrived in rsync 3.1. macOS ships openrsync, which refuses it, so a
 * Mac falls back to the in-application copy and the native suites skip there —
 * honestly, with `skipIf`. Yet FILE_TRANSFER_ENGINE is native on Linux, so
 * rsync is what copies in nearly every deployment. CI installs rsync and sets
 * `REQUIRE_NATIVE_RSYNC=1`, which turns an rsync that cannot run into a failure
 * rather than a quiet skip.
 */
const probeNativeRsync = () => {
  let directory = null;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nextexplorer-rsync-probe-'));
    const source = path.join(directory, 'source.txt');
    const copy = path.join(directory, 'copy.txt');
    fs.writeFileSync(source, 'probe');
    const result = spawnSync('rsync', ['-a', '--info=progress2', source, copy], {
      encoding: 'utf8',
      timeout: 10000,
    });
    return result.status === 0 && fs.readFileSync(copy, 'utf8') === 'probe';
  } catch {
    return false;
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
};

const NATIVE_RSYNC = probeNativeRsync();

if (process.env.REQUIRE_NATIVE_RSYNC && !NATIVE_RSYNC) {
  throw new Error(
    'REQUIRE_NATIVE_RSYNC is set but no rsync that understands --info=progress2 was found.'
  );
}

module.exports = { NATIVE_RSYNC };
