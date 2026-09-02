import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

/**
 * HEIC thumbnails, after ImageMagick was dropped from the image.
 *
 * `convert` was the only thing ImageMagick was installed for — 9.8 MB of
 * packages for one format — and ffmpeg was already here for video. The risk in
 * swapping them is not "does ffmpeg open the file": it is that a HEIC from a
 * phone is a *grid of HEVC tiles*, and a decoder that reads only the first item
 * returns one square of the picture and reports success. So this decodes a real
 * file and looks at where the colours ended up.
 *
 * The fixture is 530 bytes: left half red, right half blue. Asymmetric on
 * purpose — a mirrored or rotated result is a different picture, and a test
 * that only checked the dimensions would pass on all three.
 */

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'half-red-half-blue.heic');

/**
 * Whether the ffmpeg on this machine can read HEIF at all.
 *
 * The still-image HEIF demuxer arrived in ffmpeg 7.1. The runtime image is
 * Alpine 3.23 (ffmpeg 8.0.1) so it is always there in production, but a CI
 * runner on Ubuntu 24.04 carries 6.1 and cannot open the fixture. That is worth
 * skipping over, not worth failing over — and worth saying out loud rather than
 * passing quietly.
 */
const ffmpegReadsHeif = async () => {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nw=1:nk=1',
      FIXTURE,
    ]);
    return stdout.trim() === 'hevc';
  } catch (_) {
    return false;
  }
};

/** The decode half of makeHeicThumb, run as the service runs it. */
const decodeToWebp = (size) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error',
      '-i', FIXTURE,
      '-map', '0:v:0',
      '-frames:v', '1',
      '-vf', `scale=${size}:-1:flags=lanczos`,
      '-vcodec', 'png',
      '-f', 'image2pipe',
      'pipe:1',
    ]);
    const pipeline = sharp().webp({ quality: 80, effort: 3 });
    child.stdout.pipe(pipeline);
    child.on('error', reject);
    pipeline.toBuffer().then(resolve).catch(reject);
  });

describe('HEIC thumbnails are decoded by ffmpeg', () => {
  it('reads the fixture as HEVC, or says why it cannot', async () => {
    const readable = await ffmpegReadsHeif();
    if (!readable) {
      console.warn(
        'ffmpeg here predates the HEIF demuxer (7.1); the decode assertions below are skipped. ' +
          'The runtime image ships ffmpeg 8.0.1, where they run.'
      );
    }
    expect(typeof readable).toBe('boolean');
  });

  it('produces a WebP of the requested width', async () => {
    if (!(await ffmpegReadsHeif())) return;

    const webp = await decodeToWebp(64);
    const meta = await sharp(webp).metadata();

    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(64);
  });

  /**
   * The assertion that a tiled decode cannot fake. Reading only the first tile,
   * or losing the orientation, moves these two colours.
   */
  it('keeps red on the left and blue on the right', async () => {
    if (!(await ffmpegReadsHeif())) return;

    const webp = await decodeToWebp(64);
    const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return { r: data[i], g: data[i + 1], b: data[i + 2] };
    };

    const left = at(6, Math.floor(info.height / 2));
    const right = at(info.width - 6, Math.floor(info.height / 2));

    expect(left.r).toBeGreaterThan(200);
    expect(left.b).toBeLessThan(60);
    expect(right.b).toBeGreaterThan(200);
    expect(right.r).toBeLessThan(60);
  });

  it('writes a file the thumbnail cache can serve', async () => {
    if (!(await ffmpegReadsHeif())) return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heic-thumb-'));
    try {
      const destination = path.join(dir, 'thumb.webp');
      await fs.writeFile(destination, await decodeToWebp(96));

      const written = await fs.stat(destination);
      expect(written.size).toBeGreaterThan(0);
      expect((await sharp(destination).metadata()).format).toBe('webp');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
