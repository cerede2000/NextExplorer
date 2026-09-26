const crypto = require('crypto');

const { getDb } = require('../db');
const { generateId, nowIso } = require('../../utils/ids');
const { generateSecret, verifyTotp, otpauthUri } = require('../../utils/totp');
const { sealSecret, openSecret } = require('./totpSecrets');
const logger = require('../../utils/logger');

/**
 * A second factor on a local account.
 *
 * With an identity provider this belongs to the provider. Without one — the
 * simplest way to run this, and therefore the most common — a password is the
 * whole of what stands in front of somebody's filesystem, and a phone is a
 * cheap second thing to have to hold.
 *
 * Enrolment is two steps on purpose. The secret is written when the QR code is
 * shown and counts for nothing until a code proves the phone really has it:
 * anything else turns a mistyped setup into an account nobody can reach.
 */

const RECOVERY_CODE_COUNT = 10;

/**
 * No I, O, 0 or 1: these are read off a screen and typed back, sometimes from
 * a printout, and those four are the pairs people get wrong.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Recovery codes are hashed with SHA-256 rather than bcrypt.
 *
 * They are drawn at random with fifty bits of entropy, so there is no guessing
 * to slow down — and a slow hash would be checked against every unused code an
 * account holds at every attempt, which is a lever to push on rather than a
 * defence.
 */
const hashRecoveryCode = (code) =>
  crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

const normalizeRecoveryCode = (code) =>
  String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const drawRecoveryCode = () => {
  const letters = Array.from(
    crypto.randomBytes(10),
    (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]
  ).join('');
  // Shown in two halves, which is how they are read back.
  return `${letters.slice(0, 5)}-${letters.slice(5)}`;
};

const credentialFor = async (userId) => {
  const db = await getDb();
  return db.prepare('SELECT * FROM totp_credentials WHERE user_id = ?').get(userId) || null;
};

/** Whether this account asks for a code after its password. */
const twoFactorRequired = async (userId) => {
  const credential = await credentialFor(userId);
  return Boolean(credential?.confirmed_at);
};

/** What the settings page shows: on or off, since when, and how many codes are left. */
const twoFactorStatus = async (userId) => {
  const db = await getDb();
  const credential = await credentialFor(userId);
  const { left } = db
    .prepare(
      'SELECT COUNT(*) AS left FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL'
    )
    .get(userId);

  return {
    enabled: Boolean(credential?.confirmed_at),
    pending: Boolean(credential) && !credential.confirmed_at,
    confirmedAt: credential?.confirmed_at || null,
    recoveryCodesLeft: left,
  };
};

/**
 * Draw a secret and show it to the person setting it up.
 *
 * Asking again before confirming replaces the secret rather than adding one: a
 * QR code that was scanned into the wrong app, or a page left open yesterday,
 * should not stay valid beside the one on screen now.
 */
const beginEnrolment = async ({ userId, account }) => {
  const db = await getDb();
  if (await twoFactorRequired(userId)) {
    const error = new Error('Two-factor authentication is already on for this account.');
    error.status = 409;
    throw error;
  }

  const secret = generateSecret();
  // Taken away and written again, rather than updated in place: what is left
  // behind is one row, unconfirmed, holding the secret on the screen now.
  db.prepare('DELETE FROM totp_credentials WHERE user_id = ?').run(userId);
  db.prepare(
    `INSERT INTO totp_credentials (user_id, secret, confirmed_at, last_step, last_used_at, created_at)
     VALUES (?, ?, NULL, NULL, NULL, ?)`
  ).run(userId, sealSecret(secret), nowIso());

  return { secret, uri: otpauthUri({ secret, account }) };
};

const issueRecoveryCodes = (db, userId) => {
  db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(userId);
  const insert = db.prepare(
    'INSERT INTO totp_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)'
  );
  const codes = [];
  const now = nowIso();
  for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
    const code = drawRecoveryCode();
    codes.push(code);
    insert.run(generateId(), userId, hashRecoveryCode(code), now);
  }
  return codes;
};

/**
 * Turn it on, once a code proves the phone holds the same secret.
 *
 * The recovery codes come back here and nowhere else: they are hashed the
 * moment they are written, so this is the only time anybody can read them.
 */
const confirmEnrolment = async ({ userId, code }) => {
  const db = await getDb();
  const credential = await credentialFor(userId);
  if (!credential || credential.confirmed_at) {
    const error = new Error('There is no authenticator waiting to be confirmed.');
    error.status = 409;
    throw error;
  }

  const secret = openSecret(credential.secret);
  const step = secret ? verifyTotp(secret, code) : null;
  if (step === null) return null;

  db.prepare(
    'UPDATE totp_credentials SET confirmed_at = ?, last_step = ?, last_used_at = ? WHERE user_id = ?'
  ).run(nowIso(), step, nowIso(), userId);

  return { recoveryCodes: issueRecoveryCodes(db, userId) };
};

/** New codes for somebody who used some, or lost the paper. */
const replaceRecoveryCodes = async (userId) => {
  const db = await getDb();
  if (!(await twoFactorRequired(userId))) {
    const error = new Error('Two-factor authentication is not on for this account.');
    error.status = 409;
    throw error;
  }
  return issueRecoveryCodes(db, userId);
};

/**
 * The second step of a sign-in: a code from the phone, or one from the paper.
 *
 * A recovery code is spent when it is used, and a six-digit code is spent for
 * the thirty seconds it belongs to — both so that what somebody read over a
 * shoulder, or found in a log, is already worth nothing.
 *
 * @returns {{ ok: boolean, usedRecoveryCode?: boolean, recoveryCodesLeft?: number }}
 */
const verifySecondFactor = async ({ userId, code }) => {
  const db = await getDb();
  const credential = await credentialFor(userId);
  if (!credential?.confirmed_at) return { ok: false };

  const secret = openSecret(credential.secret);
  if (secret) {
    const step = verifyTotp(secret, code, { after: credential.last_step });
    if (step !== null) {
      db.prepare(
        'UPDATE totp_credentials SET last_step = ?, last_used_at = ? WHERE user_id = ?'
      ).run(step, nowIso(), userId);
      return { ok: true, usedRecoveryCode: false };
    }
  } else {
    // The key the secret was written under is gone. Recovery codes still work,
    // and they are the way back to an account in exactly this case.
    logger.warn({ userId }, 'A two-factor secret could not be read with the current key');
  }

  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 8) return { ok: false };

  const match = db
    .prepare(
      'SELECT id FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL AND code_hash = ?'
    )
    .get(userId, hashRecoveryCode(normalized));
  if (!match) return { ok: false };

  db.prepare('UPDATE totp_recovery_codes SET used_at = ? WHERE id = ?').run(nowIso(), match.id);
  const { left } = db
    .prepare(
      'SELECT COUNT(*) AS left FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL'
    )
    .get(userId);

  return { ok: true, usedRecoveryCode: true, recoveryCodesLeft: left };
};

/** Off, and nothing of it left: the secret, the codes, all of it. */
const disableTwoFactor = async (userId) => {
  const db = await getDb();
  db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(userId);
  const { changes } = db.prepare('DELETE FROM totp_credentials WHERE user_id = ?').run(userId);
  return changes > 0;
};

module.exports = {
  beginEnrolment,
  confirmEnrolment,
  disableTwoFactor,
  replaceRecoveryCodes,
  twoFactorRequired,
  twoFactorStatus,
  verifySecondFactor,
  RECOVERY_CODE_COUNT,
};
