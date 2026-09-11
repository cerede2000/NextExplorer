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
