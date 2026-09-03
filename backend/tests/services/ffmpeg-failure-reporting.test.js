import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { setupTestEnv } from '../helpers/env-test-utils.js';

const execFileAsync = promisify(execFile);

/**
 * Whose failure it is when a thumbnail cannot be made.
 *
 * Production logs carried this, four times in one minute, against ordinary
 * H.264 films:
 *
 *   "Input buffer contains unsupported image format"
 *      at Sharp.toFile (/app/node_modules/sharp/dist/output.cjs:90:19)
 *
 * Sharp's name, an image-format complaint, about a video file — and no way to
 * act on it. What had actually happened is that ffmpeg failed, wrote nothing to
 * standard output, and sharp was handed an empty buffer. ffmpeg's own
 * explanation went to a stderr pipe nobody read.
 *
 * That unread pipe was the second defect and the more serious one: a pipe fills
 * at 64 KB and the writer then blocks on it forever. A run that only ever
 * succeeds quietly never fills it, so nothing showed until a file ffmpeg had a
 * lot to say about arrived — and that file would hang rather than fail.
 */

let ctx;

/**
 * What the service logged.
 *
 * A thumbnail failure is swallowed on purpose — one unreadable file must not
 * stop a listing — so the log line is the only place it appears, and therefore
 * the only place worth asserting. Testing a thrown error instead would be
 * testing a layer nobody reads.
 *
 * The spy has to be attached after the environment is built, not before: the
 * setup drops every application module from the require cache, so a logger
 * taken at the top of the file is not the object the service will end up
 * holding.
 */
let logged;

const watchLogger = () => {
  logged = [];
  const logger = require('../../src/utils/logger');
  vi.spyOn(logger, 'error').mockImplementation((fields, message) => {
    logged.push({ fields, message });
  });
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
};

const hasFfmpeg = async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    return true;
  } catch (_) {
    return false;
  }
};

const setup = async () => {
  const service = await buildEnv();
  watchLogger();
  return service;
};

const buildEnv = async () => {
  ctx = await setupTestEnv({
    tag: 'ffmpeg-failure-',
    env: { THUMBNAILS: 'true' },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/services/ffmpegRunner',
      'src/services/thumbnailService',
    ],
  });
  return ctx.requireFresh('src/services/thumbnailService');
};

afterEach(async () => {
  vi.restoreAllMocks();
  if (!ctx) return;
  const service = ctx.loaded?.('src/services/thumbnailService');
  try {
    await service?.stopThumbnailWork?.();
  } catch (_) {
    // Nothing in flight.
  }
  await ctx.cleanup();
  ctx = null;
});

/** A file with a video's name and nothing a decoder can use inside it. */
const writeUndecodableVideo = async (dir, name = 'broken.mp4') => {
  const target = path.join(dir, name);
  await fs.writeFile(target, Buffer.alloc(64 * 1024, 0x7f));
  return target;
};

/**
 * Ask for a thumbnail that cannot be made, and return the error the service
 * logged. Generation is queued, so the request returns long before the work
 * fails.
 */
const failureFrom = async (service, source) => {
  await service.queueThumbnailGeneration(source, { priority: 10 });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const entry = logged.find(({ message }) => message === 'Thumbnail generation failed');
    if (entry) return entry.fields.err;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the service never reported a failure');
};

describe.skipIf(!(await hasFfmpeg()))('a video ffmpeg cannot decode', () => {
  it('fails rather than writing a thumbnail', async () => {
    const service = await setup();
    const source = await writeUndecodableVideo(ctx.volumeDir);

    expect(await failureFrom(service, source)).toBeInstanceOf(Error);
  });

  /**
   * The point of the change. Before it, this message was sharp's, and the log
   * sent whoever read it looking at the image pipeline for a fault that was
   * never there.
   */
  it('is reported as ffmpeg failing, not as sharp failing', async () => {
    const service = await setup();
    const source = await writeUndecodableVideo(ctx.volumeDir);

    const error = await failureFrom(service, source);

    expect(error.message).toMatch(/ffmpeg exited with/i);
  });

  it('says what ffmpeg exited with', async () => {
    const service = await setup();
    const source = await writeUndecodableVideo(ctx.volumeDir);

    const error = await failureFrom(service, source);

    expect(error.message).toMatch(/exited with -?\d+/);
  });

  /**
   * ffmpeg's own words, which are the only part of this that says what to do
   * about the file. Without them the exit code alone is a number.
   */
  it("carries ffmpeg's own explanation", async () => {
    const service = await setup();
    const source = await writeUndecodableVideo(ctx.volumeDir);

    const error = await failureFrom(service, source);

    expect(error.message.length).toBeGreaterThan('FFmpeg exited with 1'.length);
  });

  /** The original error is kept, so nothing is lost by renaming the failure. */
  it('keeps the underlying error as its cause', async () => {
    const service = await setup();
    const source = await writeUndecodableVideo(ctx.volumeDir);

    const error = await failureFrom(service, source);

    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe.skipIf(!(await hasFfmpeg()))('a HEIC ffmpeg cannot decode', () => {
  /** The second builder had the same unread pipe and the same wrong name. */
  it('is reported as ffmpeg failing too', async () => {
    const service = await setup();
    const source = path.join(ctx.volumeDir, 'broken.heic');
    await fs.writeFile(source, Buffer.alloc(32 * 1024, 0x11));

    const error = await failureFrom(service, source);

    expect(error?.message).toMatch(/ffmpeg exited with/i);
  });
});
