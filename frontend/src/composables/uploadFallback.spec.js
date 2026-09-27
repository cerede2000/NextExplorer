import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getUploadFallbackMiB, resetUploadFallback } from './fileUploader';

/**
 * The remembered chunk size, which is the whole of the auto-fallback feature.
 *
 * When a direct upload is rejected or stalled by a reverse proxy, the uploader
 * learns a safe chunk size and writes it here; every later upload from this
 * origin goes through TUS instead. The settings screen reads and clears the
 * same value. So these two functions are the contract between a feature that
 * heals itself and the button that undoes it — and a wrong answer is invisible:
 * uploads simply go back to failing, or stay chunked forever.
 *
 * localStorage is the awkward part. It throws outright in a Safari private
 * window and in any embedding that blocks site data, and a throw here must not
 * take the uploader down with it.
 */

const KEY = 'nextExplorer_upload_fallback_chunk_mib';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reading the remembered size', () => {
  it('returns null when nothing was ever learned', () => {
    expect(getUploadFallbackMiB()).toBeNull();
  });

  it('returns the number that was stored', () => {
    localStorage.setItem(KEY, '16');
    expect(getUploadFallbackMiB()).toBe(16);
  });

  it('accepts a fractional size', () => {
    localStorage.setItem(KEY, '1.5');
    expect(getUploadFallbackMiB()).toBe(1.5);
  });

  /**
   * Below 1 MiB is not a chunk size anyone meant. `Number('')` is 0 and
   * `Number(null)` is 0 too, so without the floor an empty entry would read as
   * a valid zero-byte chunk and every upload would be cut into nothing.
   */
  it.each([
    ['zero', '0'],
    ['a half', '0.5'],
    ['negative', '-8'],
    ['empty', ''],
    ['not a number', 'sixteen'],
    ['infinite', 'Infinity'],
  ])('refuses %s', (_label, stored) => {
    localStorage.setItem(KEY, stored);
    expect(getUploadFallbackMiB()).toBeNull();
  });

  it('accepts exactly 1, the smallest size that means something', () => {
    localStorage.setItem(KEY, '1');
    expect(getUploadFallbackMiB()).toBe(1);
  });

  /** A private window throws on read. The uploader must simply not know. */
  it('answers null rather than throwing when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    expect(() => getUploadFallbackMiB()).not.toThrow();
    expect(getUploadFallbackMiB()).toBeNull();
  });
});

describe('clearing it', () => {
  it('forgets the size, so the next upload goes direct again', () => {
    localStorage.setItem(KEY, '32');

    resetUploadFallback();

    expect(getUploadFallbackMiB()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('is harmless when there was nothing to forget', () => {
    expect(() => resetUploadFallback()).not.toThrow();
  });

  it('does not throw when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    expect(() => resetUploadFallback()).not.toThrow();
  });

  /** Only this key. Clearing the whole store would sign the visitor out. */
  it('leaves everything else in storage alone', () => {
    localStorage.setItem(KEY, '8');
    localStorage.setItem('nextExplorer_theme', 'dark');

    resetUploadFallback();

    expect(localStorage.getItem('nextExplorer_theme')).toBe('dark');
  });
});
