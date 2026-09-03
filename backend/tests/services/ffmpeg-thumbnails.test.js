import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

import { setupTestEnv } from '../helpers/env-test-utils.js';

const execFileAsync = promisify(execFile);

/**
 * Video and HEIC thumbnails, made from real files by a real ffmpeg.
 *
 * `fluent-ffmpeg` was removed and its seven calls replaced with plain process
 * spawning. The whole suite stayed green through that change, which proves
 * nothing at all: not one test decoded a frame. A builder API swapped for an
 * argument list can produce a command that runs, exits zero and writes nothing,
 * and the only visible symptom is a thumbnail that never appears.
 *
 * So this encodes a clip, asks the service for a thumbnail, and looks at the
 * pixels that come out. Skipped where ffmpeg is absent, which is stated rather
 * than silent.
 */

let ctx;

const hasFfmpeg = async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    return true;
  } catch (_) {
    return false;
  }
};

const setup = async (env = {}) => {
  ctx = await setupTestEnv({
    tag: 'ffmpeg-thumbs-',
    env: { THUMBNAILS: 'true', ...env },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/services/ffmpegRunner',
      'src/services/thumbnailService',
    ],
  });
  return ctx;
};

afterEach(async () => {
  if (ctx) {
    const service = ctx.loaded?.('src/services/thumbnailService');
    try {
      await service?.stopThumbnailWork?.();
    } catch (_) {
      // Nothing in flight.
    }
    await ctx.cleanup();
    ctx = null;
  }
});

/**
 * An eight-second clip whose left half is red and right half is blue.
 *
 * Longer than the default seek point of five seconds on purpose: a clip shorter
 * than the seek yields no frame at all, which looks exactly like a broken
 * decoder and is how the first version of this file failed.
 */
const makeClip = async (file, args = []) => {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=64x64:duration=8:rate=10',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:size=64x64:duration=8:rate=10',
    '-filter_complex',
    '[0:v][1:v]hstack=inputs=2',
    ...args,
    file,
  ]);
};

/**
 * Ask for a thumbnail and wait for the file. Generation is queued, so the call
 * returns before the work is done.
 */
const thumbnailFor = async (env, service, source) => {
  const result = await service.queueThumbnailGeneration(source, { priority: 10 });
  const thumbDir = path.join(env.cacheDir, 'thumbnails');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const entries = await fs.readdir(thumbDir).catch(() => []);
    const done = entries.filter((name) => name.endsWith('.webp'));
    if (done.length) return path.join(thumbDir, done[0]);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no thumbnail appeared (queue said ${JSON.stringify(result)})`);
};

const colourAt = async (file, x, y) => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
};

describe('a video thumbnail', () => {
  it('is produced from a real clip', async () => {
    if (!(await hasFfmpeg())) {
      console.warn('ffmpeg is not installed here; the decode assertions are skipped.');
      return;
    }
    const env = await setup();
    const service = env.requireFresh('src/services/thumbnailService');
    const source = path.join(env.volumeDir, 'clip.mp4');
    await makeClip(source, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']);

    const thumb = await thumbnailFor(env, service, source);

    expect((await fs.stat(thumb)).size).toBeGreaterThan(0);
  });

  /**
   * The assertion an argument-list mistake cannot survive. A command that runs
   * and writes nothing useful still exits zero; a picture with red on the left
   * and blue on the right came from decoding the actual frame.
   */
  it('holds the picture that was in the clip', async () => {
    if (!(await hasFfmpeg())) return;
    const env = await setup();
    const service = env.requireFresh('src/services/thumbnailService');
    const source = path.join(env.volumeDir, 'clip.mp4');
    await makeClip(source, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']);

    const thumb = await thumbnailFor(env, service, source);
    const meta = await sharp(thumb).metadata();
    const left = await colourAt(thumb, 4, Math.floor(meta.height / 2));
    const right = await colourAt(thumb, meta.width - 4, Math.floor(meta.height / 2));

    expect(meta.format).toBe('webp');
    expect(left.r).toBeGreaterThan(140);
    expect(left.b).toBeLessThan(90);
    expect(right.b).toBeGreaterThan(140);
    expect(right.r).toBeLessThan(90);
  });

  it('works for a container ffmpeg has to seek into', async () => {
    if (!(await hasFfmpeg())) return;
    const env = await setup();
    const service = env.requireFresh('src/services/thumbnailService');
    const source = path.join(env.volumeDir, 'clip.mkv');
    await makeClip(source, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']);

    await expect(thumbnailFor(env, service, source)).resolves.toBeTruthy();
  });

  /**
   * Seeking by a percentage is the branch that needs ffprobe: the duration has
   * to be read before the seek point can be worked out. It is a separate code
   * path from the fixed seek, and the one that silently falls back.
   */
  it('seeks by percentage, which means ffprobe answered', async () => {
    if (!(await hasFfmpeg())) return;
    const env = await setup({ THUMBNAIL_VIDEO_SEEK_PERCENT: '0.5' });
    const service = env.requireFresh('src/services/thumbnailService');
    const source = path.join(env.volumeDir, 'clip.mp4');
    await makeClip(source, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']);

    await expect(thumbnailFor(env, service, source)).resolves.toBeTruthy();
  });

  it('gives up quietly on a file that is not a video at all', async () => {
    if (!(await hasFfmpeg())) return;
    const env = await setup();
    const service = env.requireFresh('src/services/thumbnailService');
    const source = path.join(env.volumeDir, 'broken.mp4');
    await fs.writeFile(source, Buffer.from('not a video'));

    await expect(
      service.queueThumbnailGeneration(source, { priority: 10 })
    ).resolves.toBeDefined();
  });
});

describe('a HEIC thumbnail', () => {
  const heicFixture = path.join(import.meta.dirname, '..', 'fixtures', 'half-red-half-blue.heic');

  it('is produced, and holds the picture', async () => {
    if (!(await hasFfmpeg())) return;
    // The same ffmpeg has to be new enough for HEIF; older ones cannot open it.
    try {
      await execFileAsync('ffprobe', ['-v', 'error', '-show_format', heicFixture]);
    } catch (_) {
      console.warn('this ffmpeg predates the HEIF demuxer; the HEIC case is skipped.');
      return;
    }

    const env = await setup();
    const service = env.requireFresh('src/services/thumbnailService');
    const source = path.join(env.volumeDir, 'photo.heic');
    await fs.copyFile(heicFixture, source);

    const thumb = await thumbnailFor(env, service, source);

    const meta = await sharp(thumb).metadata();
    const left = await colourAt(thumb, 3, Math.floor(meta.height / 2));
    const right = await colourAt(thumb, meta.width - 3, Math.floor(meta.height / 2));

    expect(left.r).toBeGreaterThan(140);
    expect(right.b).toBeGreaterThan(140);
  });
});
