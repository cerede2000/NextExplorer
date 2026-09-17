const { getDb } = require('../db');
const { generateId, nowIso } = require('../../utils/ids');
const {
  SUPPORTED_ALGORITHMS,
  WebAuthnError,
  fromBase64Url,
  randomChallenge,
  toBase64Url,
  verifyAssertion,
  verifyRegistration,
} = require('../../utils/webauthn');
const logger = require('../../utils/logger');

/**
 * Passkeys: signing in with what the device holds instead of what somebody
 * remembers.
 *
 * The key never leaves the authenticator, and what it signs names this site —
 * so a passkey cannot be typed into the wrong page, read over a shoulder, or
 * replayed somewhere else. That is the whole reason this exists beside a
 * password rather than as one more password rule.
 *
 * Two ceremonies, both starting here and finishing here: making one, and using
 * one. Each begins with a challenge this server drew, which the route keeps in
 * the session and spends once — a challenge that outlives its answer is a
 * replay waiting to happen.
 */

/** Long enough to find a phone and a fingerprint; short enough to be a moment. */
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;

/** A name is for telling two authenticators apart, not for storing prose. */
const MAX_NAME_LENGTH = 60;

const CONTROL_CHARACTERS = /\p{Cc}/gu;

const cleanName = (name, fallback) => {
  const text = String(name ?? '')
    .replace(CONTROL_CHARACTERS, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return text || fallback;
};

const publicShape = (row) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  backedUp: Boolean(row.backed_up),
  transports: row.transports ? JSON.parse(row.transports) : [],
});

/** Every passkey on an account, newest first. */
const listPasskeys = async (userId) => {
  const db = await getDb();
  return db
    .prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map(publicShape);
};

const countPasskeys = async (userId) => {
  const db = await getDb();
  return db.prepare('SELECT COUNT(*) AS total FROM passkeys WHERE user_id = ?').get(userId).total;
};

/** Whether this account can sign in with a password at all. */
const hasPassword = async (userId) => {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM auth_methods
       WHERE user_id = ? AND method_type = 'local_password' AND enabled = 1
       LIMIT 1`
    )
    .get(userId);
  return Boolean(row);
};

/**
 * What the browser needs to make one.
 *
 * The credentials already on the account are listed so the authenticator can
 * refuse to make a second key for the same one — somebody pressing the button
 * twice should be told they already have this, not handed a duplicate.
 */
const beginRegistration = async ({ userId, account, displayName, rpId, rpName }) => {
  const db = await getDb();
  const existing = db
    .prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?')
    .all(userId);

  return {
    challenge: randomChallenge(),
    rp: { id: rpId, name: rpName },
    user: {
      // The account id as bytes, which is what the field is: base64url of the
      // id this server already uses, so nothing new has to be remembered.
      id: toBase64Url(Buffer.from(String(userId), 'utf8')),
      name: account,
      displayName: displayName || account,
    },
    pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    timeout: CEREMONY_TIMEOUT_MS,
    attestation: 'none',
    authenticatorSelection: {
      // Preferred, not required: a key that cannot store a credential is still
      // a passkey worth having — it is named at sign-in rather than offering
      // itself.
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((row) => ({
      type: 'public-key',
      id: row.credential_id,
      ...(row.transports ? { transports: JSON.parse(row.transports) } : {}),
    })),
  };
};

/**
 * Keep it, once it has proved it was made here, for this site, just now.
 *
 * A credential already known is refused rather than moved: one authenticator
 * may hold keys for several accounts, but one key belongs to one of them.
 */
const finishRegistration = async ({ userId, response, expected, name }) => {
  const registration = verifyRegistration({
    attestationObject: fromBase64Url(response?.attestationObject, 'attestation object'),
    clientDataJSON: fromBase64Url(response?.clientDataJSON, 'client data'),
    expectedChallenge: expected.challenge,
    expectedOrigins: expected.origins,
    expectedRpId: expected.rpId,
  });

  const db = await getDb();
  const credentialId = toBase64Url(registration.credentialId);
  const owner = db
    .prepare('SELECT user_id FROM passkeys WHERE credential_id = ?')
    .get(credentialId);
  if (owner) {
    const error = new WebAuthnError(
      owner.user_id === userId
        ? 'This passkey is already on your account.'
        : 'This passkey is already in use here.'
    );
    error.status = 409;
    throw error;
  }

  const transports = Array.isArray(response?.transports)
    ? response.transports
        .filter((value) => typeof value === 'string' && value.length < 32)
        .slice(0, 8)
    : [];

  const row = {
    id: generateId(),
    user_id: userId,
    credential_id: credentialId,
    public_key: toBase64Url(registration.credentialPublicKey),
    sign_count: registration.signCount,
    transports: transports.length ? JSON.stringify(transports) : null,
    aaguid: registration.aaguid ? registration.aaguid.toString('hex') : null,
    backed_up: registration.backedUp ? 1 : 0,
    name: cleanName(name, `Passkey ${(await countPasskeys(userId)) + 1}`),
    created_at: nowIso(),
    last_used_at: null,
  };

  db.prepare(
    `INSERT INTO passkeys
       (id, user_id, credential_id, public_key, sign_count, transports, aaguid, backed_up, name, created_at, last_used_at)
     VALUES (@id, @user_id, @credential_id, @public_key, @sign_count, @transports, @aaguid, @backed_up, @name, @created_at, @last_used_at)`
  ).run(row);

  logger.info({ userId, passkeyId: row.id }, 'A passkey was added to an account');
  return publicShape(row);
};

/**
 * What the browser needs to use one.
 *
 * No credentials are named. The authenticator offers what it holds for this
 * site, which means the sign-in screen never has to ask who is signing in —
 * and never has to say whether an account exists.
 */
const beginAuthentication = ({ rpId }) => ({
  challenge: randomChallenge(),
  rpId,
  timeout: CEREMONY_TIMEOUT_MS,
  userVerification: 'preferred',
  allowCredentials: [],
});

/**
 * Who this is, if the signature holds.
 *
 * The account is found from the credential the authenticator names, and the
 * counter is written back in the same breath as the check: the signature good
 * enough to open the door is also the one that moves the counter past itself.
 */
const finishAuthentication = async ({ response, expected }) => {
  const credentialId = String(response?.id || response?.credentialId || '');
  if (!credentialId) throw new WebAuthnError('The browser named no passkey.');

  const db = await getDb();
  const row = db
    .prepare(
      `SELECT passkeys.* FROM passkeys
       JOIN users ON users.id = passkeys.user_id
       WHERE passkeys.credential_id = ?`
    )
    .get(credentialId);
  // Deliberately the same refusal as a signature that does not verify: which
  // passkeys this server knows is not something to answer to whoever asks.
  if (!row) throw new WebAuthnError('That passkey does not open anything here.');

  const outcome = verifyAssertion({
    authenticatorData: fromBase64Url(response?.authenticatorData, 'authenticator data'),
    clientDataJSON: fromBase64Url(response?.clientDataJSON, 'client data'),
    signature: fromBase64Url(response?.signature, 'signature'),
    credentialPublicKey: fromBase64Url(row.public_key, 'public key'),
    storedSignCount: row.sign_count,
    expectedChallenge: expected.challenge,
    expectedOrigins: expected.origins,
    expectedRpId: expected.rpId,
  });

  db.prepare(
    'UPDATE passkeys SET sign_count = ?, last_used_at = ?, backed_up = ? WHERE id = ?'
  ).run(outcome.signCount, nowIso(), outcome.backedUp ? 1 : 0, row.id);

  return {
    userId: row.user_id,
    passkeyId: row.id,
    name: row.name,
    userVerified: outcome.userVerified,
  };
};

const renamePasskey = async ({ userId, id, name }) => {
  const db = await getDb();
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;
  const next = cleanName(name, row.name);
  db.prepare('UPDATE passkeys SET name = ? WHERE id = ?').run(next, id);
  return publicShape({ ...row, name: next });
};

/**
 * Take one away.
 *
 * The last passkey on an account with no password is refused: removing it
 * would be the end of the account, and one nobody can reach is worse than one
 * holding a passkey somebody no longer wants.
 */
const deletePasskey = async ({ userId, id }) => {
  const db = await getDb();
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return { removed: false, reason: 'missing' };

  if ((await countPasskeys(userId)) === 1 && !(await hasPassword(userId))) {
    return { removed: false, reason: 'last-way-in' };
  }

  db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
  logger.info({ userId, passkeyId: id }, 'A passkey was removed from an account');
  return { removed: true };
};

/** Every passkey of an account, for an administrator handing it back. */
const deleteAllPasskeys = async (userId) => {
  const db = await getDb();
  return db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(userId).changes;
};

module.exports = {
  CEREMONY_TIMEOUT_MS,
  beginAuthentication,
  beginRegistration,
  countPasskeys,
  deleteAllPasskeys,
  deletePasskey,
  finishAuthentication,
  finishRegistration,
  hasPassword,
  listPasskeys,
  renamePasskey,
};
