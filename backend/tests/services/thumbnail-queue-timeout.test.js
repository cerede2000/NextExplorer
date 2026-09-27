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
 * A thumbnail its queue has stopped waiting for.
 *
 * The queues give up on a job after thirty seconds and free its slot, and the
 * job goes on: a large photo on a slow disk, a video ffmpeg takes its time
 * over. The file used to be forgotten at that moment, so the next listing that
 * asked for its thumbnail started the same work a second time beside the first
 * — two sharp pipelines, or two ffmpeg processes, for one thumbnail.
 *
 * The timeout is shortened here, and the writes are held open, so the moment
 * after the queue gives up can be looked at rather than waited for.
 */

const SERVICE_FILE = fileURLToPath(
  new URL('../../src/services/thumbnailService.js', import.meta.url)
);
const QUEUE_TIMEOUT_MS = 40;

/** The service's queues, with their timeout cut to a few milliseconds. */
class QuickTimeoutQueue extends PQueue {
  constructor(options = {}) {
    super(options.timeout ? { ...options, timeout: QUEUE_TIMEOUT_MS } : options);
  }
}

let ctx;
let releaseHeldWrites = null;
const restores = [];

afterEach(async () => {
  // A write held open would keep the queues from ever going idle.
  releaseHeldWrites?.();
  releaseHeldWrites = null;
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

/**
 * A sharp whose file writes begin, count themselves, and then wait to be told
 * to finish. Its pipeline is a stream, so ffmpeg's output can be piped into it.
 */
const holdWrites = () => {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let reportStarted;
  const started = new Promise((resolve) => {
    reportStarted = resolve;
  });
  let writes = 0;

  const pipeline = () => {
    const stream = new PassThrough();
    stream.resume();
    return Object.assign(stream, {
      rotate: () => stream,
      resize: () => stream,
      webp: () => stream,
      toFile: async (file) => {
        writes += 1;
        await fs.writeFile(file, 'half a thumbnail');
        reportStarted(file);
        await released;
        await fs.writeFile(file, 'a thumbnail');
      },
    });
  };
  const sharp = Object.assign(pipeline, {
    concurrency: () => 1,
    cache: () => ({}),
    counters: () => ({}),
  });

  releaseHeldWrites = release;
  return { sharp, started, release, writes: () => writes };
};

/** An ffmpeg that starts, counts itself, and never finishes on its own. */
const fakeFfmpeg = () => {
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
      child.kill = () => {};
      return child;
    },
  };
  return { runner, runs: () => runs };
};

const setup = async (substitutes) => {
  ctx = await setupTestEnv({ tag: 'thumb-timeout-', env: { THUMBNAILS: 'true' } });
  // After the environment has cleared the application modules, so the service
  // required next is the one that receives these.
  for (const [request, exports] of substitutes) {
    restores.push(substituteModule(SERVICE_FILE, request, exports));
  }
  return ctx.requireFresh('src/services/thumbnailService');
};

const pastTheTimeout = () => new Promise((resolve) => setTimeout(resolve, QUEUE_TIMEOUT_MS * 5));

const eventually = async (probe) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition never held');
};

describe('a thumbnail its queue has stopped waiting for', () => {
  it('is not started a second time while it is still being written', async () => {
    const held = holdWrites();
    const service = await setup([
      ['sharp', held.sharp],
      ['p-queue', { default: QuickTimeoutQueue }],
    ]);
    const source = path.join(ctx.volumeDir, 'photo.jpg');
    await fs.writeFile(source, 'a photo');

    await service.queueThumbnailGeneration(source);
    await held.started;
    await pastTheTimeout();
    // The queue has given up on it: its slot is free, and the write goes on.
    expect(service.getDiagnosticsSnapshot().queues.thumbnail.pending).toBe(0);

    await expect(service.queueThumbnailGeneration(source)).resolves.toMatchObject({
      pending: true,
      queued: true,
    });
    await pastTheTimeout();
    expect(held.writes()).toBe(1);

    held.release();
    const thumbnail = await eventually(async () => {
      const answer = await service.queueThumbnailGeneration(source);
      return answer.thumbnail;
    });
    expect(thumbnail).toMatch(/^\/static\/thumbnails\/v3-[a-f0-9]+\.webp$/);
    expect(held.writes()).toBe(1);
  });

  it('is not given a second ffmpeg while the first is still running, for a video', async () => {
    const held = holdWrites();
    const ffmpeg = fakeFfmpeg();
    const service = await setup([
      ['sharp', held.sharp],
      ['p-queue', { default: QuickTimeoutQueue }],
      ['./ffmpegRunner', ffmpeg.runner],
    ]);
    const source = path.join(ctx.volumeDir, 'clip.mp4');
    await fs.writeFile(source, 'a video');

    await service.queueThumbnailGeneration(source);
    await held.started;
    await pastTheTimeout();
    // Both queues have given up on it: the thumbnail's and the video's.
    const { queues } = service.getDiagnosticsSnapshot();
    expect(queues.thumbnail.pending).toBe(0);
    expect(queues.video.pending).toBe(0);

    await expect(service.queueThumbnailGeneration(source)).resolves.toMatchObject({
      pending: true,
      queued: true,
    });
    await pastTheTimeout();
    expect(ffmpeg.runs()).toBe(1);

    held.release();
    const thumbnail = await eventually(async () => {
      const answer = await service.queueThumbnailGeneration(source);
      return answer.thumbnail;
    });
    expect(thumbnail).toMatch(/^\/static\/thumbnails\/v3-[a-f0-9]+\.webp$/);
    expect(ffmpeg.runs()).toBe(1);
    expect(held.writes()).toBe(1);
  });
});
