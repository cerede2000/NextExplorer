import { describe, it, expect } from 'vitest';

const { encodeBase32, decodeBase32 } = require('../../src/utils/base32');
const { generateSecret, totpCode, verifyTotp, otpauthUri } = require('../../src/utils/totp');

/**
 * The codes an authenticator app shows.
 *
 * Checked against RFC 6238's own test vectors rather than against itself: the
 * whole point of implementing this is that it agrees with every phone on the
 * planet, and only the published answers can say so.
 */

/** The RFC's secret: the ASCII digits 1234567890 twice, as base32. */
const RFC_SECRET = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  /** RFC 4648's own vectors. */
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %o', (plain, encoded) => {
    expect(encodeBase32(Buffer.from(plain, 'ascii'))).toBe(encoded);
  });

  it('reads back what it wrote', () => {
    expect(decodeBase32('MZXW6YTBOI').toString('ascii')).toBe('foobar');
  });

  /** How a secret arrives when somebody reads it off a screen. */
  it('forgives spaces, lower case and padding', () => {
    expect(decodeBase32('mzxw 6ytb oi==').toString('ascii')).toBe('foobar');
  });

  it('refuses what is not base32 rather than decoding it wrong', () => {
    expect(() => decodeBase32('MZXW6YTB01')).toThrow();
    expect(() => decodeBase32('')).toThrow();
  });
});

describe('the codes RFC 6238 publishes', () => {
  /**
   * The RFC prints eight digits; an authenticator app shows the last six of
   * the same number, which is what this produces.
   */
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('at T=%i is %s', (seconds, expected) => {
    expect(totpCode(RFC_SECRET, { at: seconds * 1000 })).toBe(expected);
  });
});

describe('checking a code', () => {
  const at = 1111111109 * 1000;

  it('accepts the code of the moment, and says which step it was', () => {
    const step = verifyTotp(RFC_SECRET, '081804', { at });
    expect(step).toBe(Math.floor(1111111109 / 30));
  });

  /** A phone whose clock is half a minute out is still that person's phone. */
  it('accepts one step either side', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, { at: at - 30000 }), { at })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, { at: at + 30000 }), { at })).not.toBeNull();
  });

  it('refuses two steps away', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, { at: at - 90000 }), { at })).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, { at: at + 90000 }), { at })).toBeNull();
  });

  /**
   * What stops a code being used twice: the account remembers the last step it
   * let through, and the same digits offered again belong to that step.
   */
  it('refuses a step already used, however right the digits are', () => {
    const step = verifyTotp(RFC_SECRET, '081804', { at });
    expect(verifyTotp(RFC_SECRET, '081804', { at, after: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, '081804', { at, after: step - 1 })).toBe(step);
  });

  it('refuses anything that is not six digits', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '0818o4', null, undefined]) {
      expect(verifyTotp(RFC_SECRET, code, { at })).toBeNull();
    }
  });

  /** Apps show the digits in two groups of three, and people type what they see. */
  it('reads a code typed with the spaces the app shows', () => {
    expect(verifyTotp(RFC_SECRET, '081 804', { at })).not.toBeNull();
  });

  it('refuses rather than throwing when the secret itself is unusable', () => {
    expect(verifyTotp('not base32!', '081804', { at })).toBeNull();
  });
});

describe('what the phone is handed', () => {
  it('draws a secret of the length the RFC uses', () => {
    const secret = generateSecret();
    expect(decodeBase32(secret)).toHaveLength(20);
    expect(secret).not.toBe(generateSecret());
  });

  it('names the account and the issuer, as every app expects', () => {
    const uri = new URL(otpauthUri({ secret: RFC_SECRET, account: 'someone@example.com' }));

    expect(uri.protocol).toBe('otpauth:');
    expect(decodeURIComponent(uri.pathname)).toBe('/NextExplorer:someone@example.com');
    expect(uri.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(uri.searchParams.get('issuer')).toBe('NextExplorer');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});
