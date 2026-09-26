const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { directories } = require('../../config');
const logger = require('../../utils/logger');

/**
 * The shared secret of somebody's authenticator, kept unreadable in the
 * database.
 *
 * Unlike a password, this one cannot be hashed: the server has to compute the
 * same six digits the phone does, so it needs the secret itself. What it can
 * do is keep it under a key that lives beside the database rather than in it,
 * so a copy of `app.db` on its own — a backup, a support ticket, a file read
 * through some other hole — is not a set of working authenticators.
 *
 * The key is drawn once into CONFIG_DIR, like the session secret. Losing it
 * does not lock anybody out: recovery codes are hashed and go on working, and
 * what cannot be read is reported as an authenticator to set up again rather
 * than as an error nobody can act on.
 */

const KEY_FILE_NAME = 'totp-key';
const KEY_PATTERN = /^[0-9a-f]{64}$/i;
const VERSION = 'v1';

let cachedKey = null;

const store = (file, hex) => {
  fs.mkdirSync(directories.config, { recursive: true });
  const staging = path.join(directories.config, `.${KEY_FILE_NAME}.tmp`);
  const fd = fs.openSync(staging, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${hex}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(staging, file);
};

/**
 * The key, drawn on first use and read back afterwards.
 *
 * Deliberately not derived from SESSION_SECRET, which the rest of the
 * application derives its own secrets from: rotating that one signs everyone
 * out, which is a nuisance, and it would also take every authenticator with
 * it, which is a lockout.
 */
const encryptionKey = () => {
  if (cachedKey) return cachedKey;

  const file = path.join(directories.config, KEY_FILE_NAME);
  try {
    const found = fs.readFileSync(file, 'utf8').trim();
    if (KEY_PATTERN.test(found)) {
      cachedKey = Buffer.from(found, 'hex');
      return cachedKey;
    }
    logger.warn(
      { file },
      'The two-factor key file is unusable and is being replaced; authenticators set up under ' +
        'the old one have to be set up again, and recovery codes still work.'
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const drawn = crypto.randomBytes(32);
  store(file, drawn.toString('hex'));
  cachedKey = drawn;
  return cachedKey;
};

/** `v1:<iv>:<tag>:<ciphertext>`, all base64. */
const sealSecret = (secret) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const sealed = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    sealed.toString('base64'),
  ].join(':');
};

/**
 * The secret back, or null when this key cannot read it.
 *
 * Null rather than a throw: a secret written under a key that has since been
 * replaced is an authenticator to set up again, and every caller has something
 * to say about that. A tampered row lands here too, which is the point of the
 * authentication tag.
 */
const openSecret = (sealed) => {
  const [version, iv, tag, body] = String(sealed || '').split(':');
  if (version !== VERSION || !iv || !tag || !body) return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString(
      'utf8'
    );
  } catch {
    return null;
  }
};

module.exports = { sealSecret, openSecret, KEY_FILE_NAME };
