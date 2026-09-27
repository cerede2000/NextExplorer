import { describe, expect, it } from 'vitest';

const { decode, decodeFirst, CborError } = require('../../src/utils/cbor');

/**
 * The CBOR reader, against the examples published with the format.
 *
 * Every vector below is from RFC 8949 Appendix A. They are the only way to
 * know this reads what the rest of the world writes rather than what its own
 * writer would have produced — the same reason the TOTP code is checked
 * against RFC 6238's published codes.
 *
 * The refusals matter as much: this parses bytes that arrive before anybody is
 * signed in, so a truncated length, a second value hiding behind the first, or
 * a form CTAP2 forbids has to be an error and not a shrug.
 */

const from = (hex) => Buffer.from(hex, 'hex');

describe('what RFC 8949 says these bytes mean', () => {
  it.each([
    ['00', 0],
    ['01', 1],
    ['0a', 10],
    ['17', 23],
    ['1818', 24],
    ['1819', 25],
    ['1864', 100],
    ['1903e8', 1000],
    ['1a000f4240', 1000000],
    ['1b000000e8d4a51000', 1000000000000],
    ['20', -1],
    ['29', -10],
    ['3863', -100],
    ['3903e7', -1000],
  ])('reads %s as %s', (hex, expected) => {
    expect(decode(from(hex))).toBe(expected);
  });

  it.each([
    ['60', ''],
    ['6161', 'a'],
    ['6449455446', 'IETF'],
    ['62225c', '"\\'],
    ['62c3bc', 'ü'],
  ])('reads the text %s', (hex, expected) => {
    expect(decode(from(hex))).toBe(expected);
  });

  it.each([
    ['40', ''],
    ['4401020304', '01020304'],
  ])('reads the bytes %s', (hex, expected) => {
    const value = decode(from(hex));
    expect(Buffer.isBuffer(value)).toBe(true);
    expect(value.toString('hex')).toBe(expected);
  });

  it.each([
    ['f4', false],
    ['f5', true],
    ['f6', null],
    ['f7', undefined],
  ])('reads the simple value %s', (hex, expected) => {
    expect(decode(from(hex))).toBe(expected);
  });

  it('reads arrays, nested ones included', () => {
    expect(decode(from('80'))).toEqual([]);
    expect(decode(from('83010203'))).toEqual([1, 2, 3]);
    expect(decode(from('8301820203820405'))).toEqual([1, [2, 3], [4, 5]]);
  });

  it('reads maps as maps, keeping integer keys integers', () => {
    expect(decode(from('a0'))).toEqual(new Map());
    expect(decode(from('a201020304'))).toEqual(
      new Map([
        [1, 2],
        [3, 4],
      ])
    );
    expect(decode(from('a26161016162820203'))).toEqual(
      new Map([
        ['a', 1],
        ['b', [2, 3]],
      ])
    );
    expect(decode(from('826161a161626163'))).toEqual(['a', new Map([['b', 'c']])]);
  });

  it('keeps a negative label apart from the text of it', () => {
    // A COSE key labels its coordinates -1, -2, -3. Decoded into an object
    // those become "-1" beside any "-1" somebody sent as text.
    // {-1: 1, "-1": 2} — the label and the text of it, side by side.
    const map = decode(from('a22001622d3102'));
    expect(map.get(-1)).toBe(1);
    expect(map.get('-1')).toBe(2);
  });
});

describe('what it refuses', () => {
  it.each([
    ['an indefinite-length byte string', '5f42010243030405ff'],
    ['an indefinite-length array', '9fff'],
    ['an indefinite-length map', 'bf61610161629f0203ffff'],
    ['a tag', 'c11a514b67b0'],
    ['a half-precision float', 'f93c00'],
    ['a double', 'fb3ff199999999999a'],
    ['an unassigned length form', '1c'],
  ])('refuses %s', (_what, hex) => {
    expect(() => decode(from(hex))).toThrow(CborError);
  });

  it('refuses a length that runs past the data', () => {
    expect(() => decode(from('4401'))).toThrow(/past the end/);
    expect(() => decode(from('83010203040506'))).toThrow(CborError);
  });

  it('refuses a second value hiding behind the first', () => {
    expect(() => decode(from('0101'))).toThrow(/more than one value/);
  });

  it('refuses the same map key twice', () => {
    expect(() => decode(from('a2010201ff'))).toThrow(CborError);
    expect(() => decode(from('a201020103'))).toThrow(/same key twice/);
  });

  it('refuses an integer too large to be read exactly', () => {
    expect(() => decode(from('1bffffffffffffffff'))).toThrow(/larger than this reads/);
  });

  it('refuses nesting without end', () => {
    // Twenty opening arrays, one deeper than it will follow.
    const deep = Buffer.from('81'.repeat(20) + '01', 'hex');
    expect(() => decode(deep)).toThrow(/nested too deeply/);
  });

  it('refuses anything that is not bytes', () => {
    expect(() => decode('0a')).toThrow(/needs bytes/);
  });
});

describe('reading one value out of more data', () => {
  it('says where the value ended', () => {
    const attestation = Buffer.concat([from('a201020304'), Buffer.from('trailing')]);
    const { value, bytesRead } = decodeFirst(attestation);

    expect(value).toEqual(
      new Map([
        [1, 2],
        [3, 4],
      ])
    );
    expect(bytesRead).toBe(5);
    expect(attestation.subarray(bytesRead).toString()).toBe('trailing');
  });

  it('hands back bytes the caller can keep', () => {
    const source = from('4401020304');
    const value = decode(source);
    source.fill(0);
    expect(value.toString('hex')).toBe('01020304');
  });
});
