import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Which media tools this machine has, for the suites that need them.
 *
 * Several suites need ffmpeg, and the HEIC ones need an ffmpeg that can read
 * HEIF, which it only could from 7.1. Where a tool is missing, those suites
 * skip — and say so, through skipIf, so the run reports them as skipped. They
 * used to return early from the test body instead, which the runner counts as
 * a pass: on every CI run, whose Ubuntu ffmpeg is 6.1, the HEIC decode was
 * reported green having asserted nothing.
 *
 * Skipping is right on a laptop that lacks a tool, and wrong where the tool
 * was installed on purpose. REQUIRE_MEDIA_TOOLS lists the ones that must be
 * there (`ffmpeg`, `heif`, comma-separated); a missing one then fails the
 * suite at load, by name, rather than skipping it — so a CI image that stops
 * carrying ffmpeg turns red instead of quietly running less.
 */

export const HEIC_FIXTURE = path.join(
  import.meta.dirname,
  '..',
  'fixtures',
  'half-red-half-blue.heic'
);

const required = new Set(
  (process.env.REQUIRE_MEDIA_TOOLS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
);

const probe = async (name, check) => {
  let available;
  try {
    available = await check();
  } catch (_) {
    available = false;
  }
  if (!available && required.has(name)) {
    throw new Error(
      `REQUIRE_MEDIA_TOOLS asks for ${name}, and this machine does not have it; ` +
        'the suites that need it would otherwise skip without anyone noticing.'
    );
  }
  return available;
};

export const hasFfmpeg = () =>
  probe('ffmpeg', async () => {
    await execFileAsync('ffmpeg', ['-version']);
    return true;
  });

/** HEIF is read when ffprobe finds the HEVC picture inside the fixture. */
export const ffmpegReadsHeif = () =>
  probe('heif', async () => {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'default=nw=1:nk=1',
      HEIC_FIXTURE,
    ]);
    return stdout.trim() === 'hevc';
  });

/**
 * 7-Zip, which is what reads an archive's table of contents.
 *
 * Named here rather than probed inline for the same reason as the rest: a
 * machine without it skips those suites, and CI asks for it by name so that a
 * skip there is a failure instead of a quiet gap.
 */
export const hasSevenZip = () =>
  probe('7z', async () => {
    await execFileAsync(process.env.SEVEN_ZIP_PATH || '7z', ['i']);
    return true;
  });

/**
 * Something that can build an ISO image, so the format can be covered without
 * a binary fixture in the repository: `genisoimage` or `mkisofs` on Linux,
 * `hdiutil` on a Mac. An ISO is worth covering because it is the one format in
 * the offered list that is a filesystem rather than an archive, and 7-Zip is
 * what makes it look like the others.
 */
export const isoBuilder = () =>
  probe('iso', async () => {
    for (const [command, args] of [
      ['genisoimage', ['--version']],
      ['mkisofs', ['-version']],
      ['hdiutil', ['help']],
    ]) {
      try {
        await execFileAsync(command, args);
        return command;
      } catch (_) {
        // The next one, or none.
      }
    }
    return false;
  });

/** Write `directory` as an ISO image at `file`, with whichever builder there is. */
export const buildIso = async (builder, directory, file) => {
  if (builder === 'hdiutil') {
    await execFileAsync('hdiutil', [
      'makehybrid',
      '-iso',
      '-joliet',
      '-o',
      file,
      directory,
      '-quiet',
    ]);
    return;
  }
  await execFileAsync(builder, ['-quiet', '-J', '-r', '-o', file, directory]);
};
