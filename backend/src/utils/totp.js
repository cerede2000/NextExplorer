const crypto = require('crypto');

const { encodeBase32, decodeBase32 } = require('./base32');

/**
 * One-time codes, as RFC 6238 defines them.
 *
 * Six digits from an HMAC of the number of thirty-second steps since the
 * epoch, which is what Google Authenticator, Aegis, 1Password and the rest all
 * compute. The whole of it is the four functions below, and they are checked
 * against the RFC's own test vectors — a dependency would be more code to trust
 * for the same arithmetic.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/**
 * How far out of step a code is still accepted.
 *
 * One step either side: a phone whose clock is half a minute out, and a code
 * read at the end of its window and typed at the start of the next. Two would
 * be ninety seconds of validity for something a shoulder-surfer can read.
 */
const WINDOW = 1;

/** A secret of twenty bytes, the length the RFC's own vectors use. */
const generateSecret = () => encodeBase32(crypto.randomBytes(20));

const codeForStep = (key, step, digits = DIGITS) => {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  // The RFC's dynamic truncation: the low nibble of the last byte says where
  // to read the four bytes that become the code.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** digits).padStart(digits, '0');
};

/** The code for a secret at a moment, in milliseconds since the epoch. */
const totpCode = (secret, { at = Date.now(), digits = DIGITS, step = STEP_SECONDS } = {}) =>
  codeForStep(decodeBase32(secret), Math.floor(at / 1000 / step), digits);

/**
 * Check a code, and say which step it was.
 *
 * The step is the answer rather than a boolean because it is what stops a code
 * being used twice: an account records the last step it accepted, and a code
 * from that step or earlier is refused however correct its digits are. Someone
 * reading the six digits over a shoulder has thirty seconds and an account
 * that already used them.
 *
 * @returns {number|null} the step the code belongs to, or null
 */
const verifyTotp = (secret, code, { at = Date.now(), window = WINDOW, after = null } = {}) => {
  const digits = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;

  let key;
  try {
    key = decodeBase32(secret);
  } catch {
    return null;
  }

  const current = Math.floor(at / 1000 / STEP_SECONDS);
  for (let drift = -window; drift <= window; drift += 1) {
    const step = current + drift;
    if (after !== null && step <= after) continue;
    // Constant time, so a wrong code tells nothing by how long it took.
    const expected = Buffer.from(codeForStep(key, step));
    const given = Buffer.from(digits);
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return step;
  }
  return null;
};

/**
 * The address an authenticator app reads from a QR code.
 *
 * The label carries the account and the issuer both, which is the convention
 * every app follows to show "NextExplorer (someone@example.com)" rather than
 * six digits belonging to nothing.
 */
const otpauthUri = ({ secret, account, issuer = 'NextExplorer' }) => {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
};

module.exports = { generateSecret, totpCode, verifyTotp, otpauthUri, STEP_SECONDS, DIGITS, WINDOW };
