import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import PQueue from 'p-queue';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { substituteModule } from '../helpers/substitute-module.js';

/**
 * An ffmpeg that never exits.
 *
 * The queues time out and free the slot, and that is all they do: the job goes
 * on, on purpose, so that a thumbnail still being written is not started a
 * second time. Nothing else ever ended the run. A process wedged on a file it
 * cannot decode therefore held that one file's thumbnail in flight until the
 * server was restarted — every later request found the file already in flight
 * and waited behind a promise that would never settle.
 *
 * The ceiling is the only thing that ends such a run. Both places that start
 * ffmpeg get it: a video, and a HEIC photo.
 *
 * It is cut to a second here, and the queues to a few milliseconds, so that
 * the order of the two can be looked at rather than waited out.
 */

const SERVICE_FILE = fileURLToPath(
  new URL('../../src/services/thumbnailService.js', import.meta.url)
);
const QUEUE_TIMEOUT_MS = 40;
const CEILING_MS = 1000;

/** The service's queues, with their timeout cut to a few milliseconds. */
class QuickTimeoutQueue extends PQueue {
  constructor(options = {}) {
    super(options.timeout ? { ...options, timeout: QUEUE_TIMEOUT_MS } : options);
  }
}

let ctx;
const restores = [];

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
  while (restores.length) restores.pop()();
});

/** An ffmpeg that starts, writes nothing, and never exits. */
const wedgedFfmpeg = () => {
  const signals = [];
  let runs = 0;
  const runner = {
    ffmpegPath: '/fake/ffmpeg',
    ffprobePath: '/fake/ffprobe',
    hasFfmpeg: () => true,
    hasFfprobe: () => true,
    probe: async () => ({ format: { duration: 8 } }),
    run: () => {
      runs += 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => signals.push(signal);
      return child;
    },
  };
  return { runner, signals, runs: () => runs };
};

/**
 * A sharp whose write cannot finish on its own: ffmpeg sends nothing, so the
 * only thing that can settle it is the pipeline being torn down.
 */
const neverFinishingSharp = () => {
  const pipeline = () => {
    const stream = new PassThrough();
    stream.resume();
    return Object.assign(stream, {
      rotate: () => stream,
      resize: () => stream,
      webp: () => stream,
      toFile: () =>
        new Promise((_resolve, reject) => {
          stream.on('error', reject);
          stream.on('close', () => reject(new Error('the pipeline was torn down')));
        }),
    });
  };
  return Object.assign(pipeline, {
    concurrency: () => 1,
    cache: () => ({}),
    counters: () => ({}),
  });
};

const setup = async (substitutes) => {
  ctx = await setupTestEnv({
    tag: 'thumb-ceiling-',
    env: { THUMBNAILS: 'true', THUMBNAIL_FFMPEG_TIMEOUT_MS: String(CEILING_MS) },
  });
  for (const [request, exports] of substitutes) {
    restores.push(substituteModule(SERVICE_FILE, request, exports));
  }
  return ctx.requireFresh('src/services/thumbnailService');
};

const pastTheQueueTimeout = () =>
  new Promise((resolve) => setTimeout(resolve, QUEUE_TIMEOUT_MS * 5));

const eventually = async (probe) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition never held');
};

const startedOn = async (service, source) => {
  await service.queueThumbnailGeneration(source);
  await eventually(async () => service.getDiagnosticsSnapshot().counts.activeExternalProcesses > 0);
};

describe('an ffmpeg that never exits', () => {
  it('is left alone while the queue gives up on it, then killed at the ceiling', async () => {
    const ffmpeg = wedgedFfmpeg();
    const service = await setup([
      ['sharp', neverFinishingSharp()],
      ['p-queue', { default: QuickTimeoutQueue }],
      ['./ffmpegRunner', ffmpeg.runner],
    ]);
    const source = path.join(ctx.volumeDir, 'clip.mp4');
    await fs.writeFile(source, 'a video');

    await startedOn(service, source);
    await pastTheQueueTimeout();

    // The queues have stopped waiting, and the run is untouched: the file is
    // still in flight behind it, and no second ffmpeg is started for it.
    const { queues, counts } = service.getDiagnosticsSnapshot();
    expect(queues.thumbnail.pending).toBe(0);
    expect(queues.video.pending).toBe(0);
    expect(counts.inflight).toBe(1);
    expect(ffmpeg.signals).toEqual([]);
    await expect(service.queueThumbnailGeneration(source)).resolves.toMatchObject({
      pending: true,
      queued: true,
    });
    expect(ffmpeg.runs()).toBe(1);

    // And then the ceiling ends it.
    await eventually(async () => ffmpeg.signals.length > 0);
    expect(ffmpeg.signals).toContain('SIGKILL');

    // The file is no longer held: it is a failure now, remembered for its ten
    // minutes and asked again after them, rather than in flight until a restart.
    await eventually(async () => service.getDiagnosticsSnapshot().counts.inflight === 0);
    expect(service.getDiagnosticsSnapshot().counts.failedCache).toBe(1);
    await expect(service.queueThumbnailGeneration(source)).resolves.toMatchObject({
      pending: false,
      queued: false,
    });
  });

  it('is killed at the ceiling for a HEIC photo too', async () => {
    const ffmpeg = wedgedFfmpeg();
    const service = await setup([
      ['sharp', neverFinishingSharp()],
      ['p-queue', { default: QuickTimeoutQueue }],
      ['./ffmpegRunner', ffmpeg.runner],
    ]);
    const source = path.join(ctx.volumeDir, 'photo.heic');
    await fs.writeFile(source, 'a photo');

    await startedOn(service, source);
    await pastTheQueueTimeout();
    expect(ffmpeg.signals).toEqual([]);

    await eventually(async () => ffmpeg.signals.length > 0);
    expect(ffmpeg.signals).toContain('SIGKILL');
    await eventually(async () => service.getDiagnosticsSnapshot().counts.inflight === 0);
    expect(service.getDiagnosticsSnapshot().counts.failedCache).toBe(1);
  });
});
