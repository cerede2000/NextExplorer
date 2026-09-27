import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { createRequire } from 'node:module';
import { substituteModule } from '../helpers/substitute-module.js';

// The decision below is a pure function on the service; requiring it here
// rather than through the env harness keeps these cases free of a filesystem.
const { chooseExiftoolPath, EXIFTOOL_CANDIDATES } = createRequire(import.meta.url)(
  '../../src/services/rawPreviewService.js'
);

/**
 * Which ExifTool reads a RAW file.
 *
 * The archive brings its own, which is 23 MB of Perl and the right default —
 * one dependency less to explain, and the version this was tested against.
 * Somebody installing outside a container may already have ExifTool and would
 * rather not carry a second copy (#9), so `EXIFTOOL_PATH` points at theirs.
 *
 * What is held here is only which one is used: the library is the same, and
 * everything after it is the same code.
 */

const SERVICE_FILE = fileURLToPath(
  new URL('../../src/services/rawPreviewService.js', import.meta.url)
);

let currentEnv = null;
let restoreModule = null;

afterEach(async () => {
  if (restoreModule) {
    restoreModule();
    restoreModule = null;
  }
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

/**
 * A stand-in for `exiftool-vendored` that says which of the two was asked.
 *
 * Neither extracts anything: what the caller does with a RAW file it cannot
 * read is the same either way, and is not what this is about.
 */
const fakeVendored = () => {
  const asked = [];
  const built = [];

  const refuse = (which) => async () => {
    asked.push(which);
    throw new Error('nothing to extract');
  };

  const bundled = {
    extractPreview: refuse('bundled'),
    extractThumbnail: refuse('bundled'),
    extractJpgFromRaw: refuse('bundled'),
    end: async () => {},
  };

  class ExifTool {
    constructor(options) {
      built.push(options);
      this.extractPreview = refuse('machine');
      this.extractThumbnail = refuse('machine');
      this.extractJpgFromRaw = refuse('machine');
      this.end = async () => {};
    }
  }

  return { asked, built, module: { exiftool: bundled, ExifTool } };
};

const askFor = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'raw-preview-exiftool-', env });
  const fake = fakeVendored();
  restoreModule = substituteModule(SERVICE_FILE, 'exiftool-vendored', fake.module);

  const service = currentEnv.requireFresh('src/services/rawPreviewService');
  const raw = path.join(currentEnv.volumeDir, 'photo.cr2');
  await fs.writeFile(raw, Buffer.from('not really a raw file'));

  // It will fail — nothing here extracts anything. Which ExifTool it asked is
  // the answer being looked for.
  await expect(service.getRawPreviewJpegPath(raw)).rejects.toThrow();
  await service.stopRawPreviewWork?.();
  return fake;
};

describe('which ExifTool reads a RAW file', () => {
  it('uses the one in the archive when nothing says otherwise', async () => {
    const fake = await askFor();

    expect(fake.built).toEqual([]);
    expect(fake.asked).toContain('bundled');
    expect(fake.asked).not.toContain('machine');
  });

  it("uses the machine's when EXIFTOOL_PATH names one", async () => {
    const fake = await askFor({ EXIFTOOL_PATH: '/usr/bin/exiftool' });

    expect(fake.built).toEqual([{ exiftoolPath: '/usr/bin/exiftool' }]);
    expect(fake.asked).toContain('machine');
    expect(fake.asked).not.toContain('bundled');
  });

  it('treats a blank setting as no setting at all', async () => {
    const fake = await askFor({ EXIFTOOL_PATH: '   ' });

    // A variable left empty in a configuration file is somebody who did not
    // choose, not somebody who chose the empty path.
    expect(fake.built).toEqual([]);
    expect(fake.asked).toContain('bundled');
  });
});

/**
 * And which one it settles on when nobody said.
 *
 * The minimal archive leaves the 21 MB of Perl behind so a distribution can
 * supply it, and until now that meant `apt install libimage-exiftool-perl`
 * plus a variable nobody was told about (#9). The rule is read here on its
 * own, because the probing around it is filesystem and the order is the part
 * that can be wrong.
 */
describe('choosing an ExifTool when nothing named one', () => {
  const choose = ({ named = '', vendored = false, present = [] } = {}) =>
    chooseExiftoolPath({
      named,
      vendored,
      candidates: EXIFTOOL_CANDIDATES,
      runnable: (candidate) => present.includes(candidate),
    });

  it('takes what EXIFTOOL_PATH names, before anything else', () => {
    expect(
      choose({ named: '/opt/mine/exiftool', vendored: true, present: ['/usr/bin/exiftool'] })
    ).toBe('/opt/mine/exiftool');
  });

  it('keeps the bundled one when it travelled', () => {
    // The tested version, and the one the full archive carries: a machine that
    // also has its own does not get quietly switched to it.
    expect(choose({ vendored: true, present: ['/usr/bin/exiftool'] })).toBe('');
  });

  it("falls to the machine's own when the bundled one is not there", () => {
    expect(choose({ vendored: false, present: ['/usr/bin/exiftool'] })).toBe('/usr/bin/exiftool');
  });

  it('prefers the first candidate over a later one', () => {
    expect(
      choose({ vendored: false, present: ['/usr/local/bin/exiftool', '/usr/bin/exiftool'] })
    ).toBe('/usr/bin/exiftool');
  });

  it('says nothing rather than something wrong when there is none', () => {
    // The caller then has no ExifTool, which is a supported state: no RAW
    // metadata, and everything else carries on.
    expect(choose({ vendored: false, present: [] })).toBe('');
  });

  it('looks where a distribution puts it, and not on PATH', () => {
    // The PATH a service inherits is whatever started it, and this one may be
    // running as root — the same reason ffmpegRunner resolves absolute paths.
    expect(EXIFTOOL_CANDIDATES.every((candidate) => candidate.startsWith('/'))).toBe(true);
    expect(EXIFTOOL_CANDIDATES).toContain('/usr/bin/exiftool');
  });
});
