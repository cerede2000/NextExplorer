import { describe, it, expect } from 'vitest';
import { parseByteRange } from '../../src/utils/httpRange.js';

/**
 * Two routes used to parse ranges with their own copy of this logic. Pinning
 * the behaviour here means the shared one cannot drift.
 */
describe('parseByteRange', () => {
  it('returns null when no range was requested', () => {
    expect(parseByteRange(undefined, 1000)).toBeNull();
    expect(parseByteRange('', 1000)).toBeNull();
  });

  it('reads an explicit range', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99, chunkSize: 100 });
    expect(parseByteRange('bytes=500-999', 1000)).toEqual({ start: 500, end: 999, chunkSize: 500 });
  });

  it('treats an open end as "to the last byte"', () => {
    expect(parseByteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999, chunkSize: 100 });
  });

  it('clamps an end past the file size', () => {
    expect(parseByteRange('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999, chunkSize: 1000 });
  });

  it('flags a header that is not a byte range', () => {
    expect(parseByteRange('items=0-99', 1000)).toEqual({ malformed: true });
  });

  it('flags a range that cannot be satisfied', () => {
    expect(parseByteRange('bytes=900-100', 1000)).toEqual({ unsatisfiable: true });
  });
});

describe('Suffix ranges', () => {
  it('serves the last N bytes, not the first N', () => {
    // A media player asking for the tail of a file used to receive the head,
    // with a 206 and a plausible Content-Range to match.
    expect(parseByteRange('bytes=-500', 2000)).toEqual({
      start: 1500,
      end: 1999,
      chunkSize: 500,
    });
  });

  it('clamps a suffix longer than the file to the whole file', () => {
    expect(parseByteRange('bytes=-5000', 100)).toEqual({ start: 0, end: 99, chunkSize: 100 });
  });

  it('rejects a zero-length suffix', () => {
    expect(parseByteRange('bytes=-0', 100)).toEqual({ unsatisfiable: true });
  });
});
