const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A writable directory on another device than the temporary directory, or null.
 *
 * The trash refuses to put anything in a zone on another device, because a
 * rename there is impossible and a copy is exactly what it must never do. That
 * refusal is only proven against a real second device: on Linux, `/dev/shm`
 * is a tmpfs beside a disk-backed temporary directory. A Mac has nothing
 * writable to offer, so the suites skip there — honestly, with `skipIf` — and
 * CI sets `REQUIRE_CROSS_DEVICE=1`, which turns a missing device into a failure
 * rather than a quiet skip.
 */
const findOtherDevice = () => {
  const tmpDevice = fs.statSync(os.tmpdir()).dev;
  const candidates = [process.env.CROSS_DEVICE_DIR, '/dev/shm'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).dev === tmpDevice) continue;
      const probe = fs.mkdtempSync(path.join(candidate, 'nextexplorer-xdev-'));
      fs.rmSync(probe, { recursive: true, force: true });
      return candidate;
    } catch {
      // Not there, or not writable: try the next one.
    }
  }
  return null;
};

const OTHER_DEVICE = findOtherDevice();

if (process.env.REQUIRE_CROSS_DEVICE && !OTHER_DEVICE) {
  throw new Error(
    'REQUIRE_CROSS_DEVICE is set but no writable directory on a second device was found.'
  );
}

module.exports = { OTHER_DEVICE };
