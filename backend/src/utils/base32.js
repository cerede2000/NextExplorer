/**
 * Base32, the alphabet an authenticator app reads.
 *
 * RFC 4648 without padding, which is what every `otpauth://` URI carries and
 * what every app shows when somebody types a secret in by hand. Written here
 * rather than taken from a package: it is thirty lines, it has test vectors of
 * its own, and a secret is not a thing to hand to one more dependency.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const VALUES = new Map([...ALPHABET].map((letter, index) => [letter, index]));

/** Bytes to base32, no padding. */
const encodeBase32 = (bytes) => {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
};

/**
 * Base32 to bytes.
 *
 * Spaces and lower case are accepted because that is how a secret arrives when
 * somebody reads it off a screen and types it into their phone; padding is
 * accepted because some apps write it. Anything else is not a secret, and
 * saying so beats decoding it into the wrong bytes.
 */
const decodeBase32 = (text) => {
  const cleaned = String(text || '')
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (cleaned === '' || /[^A-Z2-7]/.test(cleaned)) {
    throw new Error('That is not base32.');
  }

  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const letter of cleaned) {
    value = (value << 5) | VALUES.get(letter);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

module.exports = { encodeBase32, decodeBase32 };
