import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Which coding a response is sent in, read from what the client wrote.
 *
 * What a browser sends is easy; what matters is what it refuses. A coding
 * refused with `q=0` and sent anyway is a page the client cannot read, and it
 * says so in the same header that accepts it.
 */

let envContext;
let chooseEncoding;

beforeAll(async () => {
  envContext = await setupTestEnv({ tag: 'compressed-response-test-' });
  ({ chooseEncoding } = envContext.requireFresh('src/utils/compressedResponse'));
});

afterAll(async () => {
  await envContext.cleanup();
});

describe('choosing the content coding', () => {
  it.each([
    // What browsers send: Edge and Chrome over plain http, then over HTTPS.
    ['gzip, deflate', 'gzip'],
    ['gzip, deflate, br, zstd', 'br'],
    ['br', 'br'],
    ['GZIP', 'gzip'],
    ['x-gzip', 'gzip'],
    ['*', 'br'],
  ])('%j → %s', (header, expected) => {
    expect(chooseEncoding(header)).toBe(expected);
  });

  it.each([
    ['br;q=0, gzip', 'gzip'],
    ['gzip;q=0, deflate', 'identity'],
    ['br;q=0, gzip;q=0', 'identity'],
    ['gzip; q=0.000', 'identity'],
    ['*;q=0', 'identity'],
    ['gzip, *;q=0', 'gzip'],
  ])('honours a refusal: %j → %s', (header, expected) => {
    expect(chooseEncoding(header)).toBe(expected);
  });

  it.each([
    ['br;q=0.5, gzip;q=0.8', 'gzip'],
    ['gzip;q=0.2, br;q=0.3', 'br'],
    ['identity, gzip;q=0.5', 'identity'],
    ['gzip;q=0.001', 'gzip'],
  ])('follows the qualities: %j → %s', (header, expected) => {
    expect(chooseEncoding(header)).toBe(expected);
  });

  it.each([
    [undefined, 'identity'],
    ['', 'identity'],
    ['identity', 'identity'],
    ['deflate', 'identity'],
    // A quality that is not one is not an acceptance.
    ['gzip;q=1.5', 'identity'],
    ['gzip;q=high', 'identity'],
  ])('sends nothing compressed without a clear yes: %j → %s', (header, expected) => {
    expect(chooseEncoding(header)).toBe(expected);
  });
});
