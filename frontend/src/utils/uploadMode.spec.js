import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CHUNK_BYTES,
  isInFallbackChunked,
  isLargeUpload,
  isWatchingDirectUploads,
  resolveUploadMode,
} from './uploadMode';

const MIB = 1024 * 1024;

/**
 * How the next upload goes out.
 *
 * This is the feature that heals itself: a direct upload refused or silently
 * stalled by a reverse proxy teaches the browser a chunk size, and every later
 * upload from that origin goes through TUS instead. Which means the decision
 * has three inputs whose *order* is the whole rule, and getting the order wrong
 * does not error — it either uploads in chunks forever when it need not, or
 * keeps sending bodies a proxy will keep dropping.
 *
 * The administrator's setting wins outright, because their reason is usually a
 * proxy they already know about and no per-browser learning should talk the
 * client out of it. Then the learned size. Then direct, which is one request
 * and much faster.
 */

const settings = (overrides = {}) => ({
  chunkedEnabled: false,
  chunkedAutoFallback: true,
  chunkSizeBytes: 16 * MIB,
  ...overrides,
});

describe('when the administrator has forced chunked uploads', () => {
  it('chunks, at the size they configured', () => {
    const result = resolveUploadMode(settings({ chunkedEnabled: true }), null);

    expect(result).toMatchObject({
      mode: 'forced-chunked',
      chunkedEnabled: true,
      chunkSizeBytes: 16 * MIB,
    });
  });

  /**
   * The precedence that matters. A size this browser learned describes one
   * proxy; the administrator's setting describes the deployment.
   */
  it('ignores a size this origin had learned', () => {
    const result = resolveUploadMode(settings({ chunkedEnabled: true }), 8);

    expect(result.chunkSizeBytes).toBe(16 * MIB);
  });

  it('ignores it whether or not auto-fallback is allowed', () => {
    const off = resolveUploadMode(settings({ chunkedEnabled: true, chunkedAutoFallback: false }), 8);

    expect(off.chunkedEnabled).toBe(true);
    expect(off.chunkSizeBytes).toBe(16 * MIB);
  });

  it('falls back to a sane size when none was configured', () => {
    const result = resolveUploadMode({ chunkedEnabled: true }, null);

    expect(result.chunkSizeBytes).toBe(DEFAULT_CHUNK_BYTES);
  });

  it.each([
    ['not a number', 'lots'],
    ['null', null],
    ['NaN', Number.NaN],
  ])('falls back when the configured size is %s', (_label, chunkSizeBytes) => {
    const result = resolveUploadMode(settings({ chunkedEnabled: true, chunkSizeBytes }), null);

    expect(result.chunkSizeBytes).toBe(DEFAULT_CHUNK_BYTES);
  });
});

describe('when this origin has learned a size', () => {
  it('chunks at that size rather than the configured one', () => {
    const result = resolveUploadMode(settings(), 32);

    expect(result).toMatchObject({
      mode: 'fallback-chunked',
      chunkedEnabled: true,
      chunkSizeBytes: 32 * MIB,
    });
  });

  /** Learning only happens where the deployment allows it. */
  it('ignores what it learned when auto-fallback is switched off', () => {
    const result = resolveUploadMode(settings({ chunkedAutoFallback: false }), 32);

    expect(result.chunkedEnabled).toBe(false);
  });

  it.each([
    ['nothing learned', null],
    ['zero', 0],
    ['undefined', undefined],
  ])('goes direct for %s', (_label, remembered) => {
    const result = resolveUploadMode(settings(), remembered);

    expect(result).toMatchObject({ mode: 'direct', chunkedEnabled: false });
  });
});

describe('going direct', () => {
  it('is the answer when nothing has gone wrong yet', () => {
    expect(resolveUploadMode(settings(), null).chunkedEnabled).toBe(false);
  });

  it('carries the configured size anyway, for when it does fall back', () => {
    expect(resolveUploadMode(settings(), null).chunkSizeBytes).toBe(16 * MIB);
  });

  it('is the answer for settings that have not loaded at all', () => {
    expect(resolveUploadMode(undefined, null)).toMatchObject({
      chunkedEnabled: false,
      chunkSizeBytes: DEFAULT_CHUNK_BYTES,
    });
  });
});

describe('whether the stall watchdog should be running', () => {
  /**
   * It gates timers on every large upload, so it has to be false wherever a
   * stall teaches nothing: with chunking forced there is no direct upload to
   * stall, and with auto-fallback off there is nowhere to record the lesson.
   */
  it('runs only while uploads are direct and fallback is allowed', () => {
    expect(isWatchingDirectUploads(settings(), null)).toBe(true);
  });

  it.each([
    ['chunking is forced', { chunkedEnabled: true }, null],
    ['auto-fallback is off', { chunkedAutoFallback: false }, null],
    ['a size was already learned', {}, 16],
  ])('does not run when %s', (_label, overrides, remembered) => {
    expect(isWatchingDirectUploads(settings(overrides), remembered)).toBe(false);
  });
});

describe('whether this origin has already fallen back', () => {
  it('is true only with a learned size and fallback allowed', () => {
    expect(isInFallbackChunked(settings(), 16)).toBe(true);
    expect(isInFallbackChunked(settings(), null)).toBe(false);
    expect(isInFallbackChunked(settings({ chunkedAutoFallback: false }), 16)).toBe(false);
    expect(isInFallbackChunked(settings({ chunkedEnabled: true }), 16)).toBe(false);
  });

  /** The two states are exclusive: a browser is watching, or it has learned. */
  it.each([
    [null],
    [8],
    [96],
  ])('is never true at the same time as the watchdog (learned: %s)', (remembered) => {
    for (const overrides of [{}, { chunkedEnabled: true }, { chunkedAutoFallback: false }]) {
      const config = settings(overrides);
      expect(
        isWatchingDirectUploads(config, remembered) && isInFallbackChunked(config, remembered)
      ).toBe(false);
    }
  });
});

describe('which files are worth watching', () => {
  it('watches one larger than eight mebibytes', () => {
    expect(isLargeUpload({ size: 9 * MIB })).toBe(true);
  });

  it('does not watch one at or below it', () => {
    expect(isLargeUpload({ size: 8 * MIB })).toBe(false);
    expect(isLargeUpload({ size: 1024 })).toBe(false);
  });

  it.each([
    ['no size', {}],
    ['a size that is not a number', { size: 'big' }],
    ['nothing at all', null],
    ['undefined', undefined],
  ])('treats %s as small rather than throwing', (_label, file) => {
    expect(isLargeUpload(file)).toBe(false);
  });
});
