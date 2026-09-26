const crypto = require('crypto');

const { getDb } = require('./db');
const { nowIso } = require('../utils/ids');
const logger = require('../utils/logger');

/**
 * API tokens: a credential for a script, narrower than the account it belongs
 * to and revocable on its own.
 *
 * Before this existed, automation signed in as a person and held a full
 * session cookie: as wide as the account, as long-lived as the session, and
 * impossible to take away without changing the password — which takes every
 * other script down with it. A token is the opposite of all three.
 *
 * Three decisions carry the security of this file, and each is written down
 * where it is made:
 *
 * - the value is shown once and stored as a hash, so a stolen database hands
 *   out no working credential;
 * - the value names itself — `nxe_<id>_<secret>` — so the row is found by the
 *   public half and only the secret half is ever compared, in constant time;
 * - a revoked token leaves a tombstone, so "somebody is still using the token
 *   I revoked" is a thing the log can say rather than a thing that looks like
 *   noise.
 */

/**
 * The shape of a token, and why it has one.
 *
 * `nxe_` makes it greppable — in a repository, in a log, in a secret scanner —
 * which is the difference between finding a leaked credential and hearing
 * about it later. The identifier that follows is public and indexed: without
 * it, authenticating one request means hashing the candidate against every
 * token in the table.
 */
const TOKEN_PREFIX = 'nxe';
const TOKEN_PATTERN = /^nxe_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

/** 8 bytes of identifier, 32 of secret: guessing the second is not a strategy. */
const ID_BYTES = 8;
const SECRET_BYTES = 32;

/**
 * What a token may do.
 *
 * `read` is the case worth having first and the default: a token that can only
 * ask questions is one that cannot be turned into a deletion. `write` is
 * everything its owner can do with files — never more, and never the two
 * things below, whichever scope it carries.
 */
const SCOPES = new Set(['read', 'write']);
const DEFAULT_SCOPE = 'read';

/** A name is for recognising a token months later, not for storing prose. */
const MAX_NAME_LENGTH = 60;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * Enough for every script on a machine; few enough that a runaway loop cannot
 * fill the table. Counted over live tokens only — tombstones are bookkeeping.
 */
const MAX_TOKENS_PER_USER = 50;

/** A token may be given a life; the longest one anybody may ask for. */
const MAX_EXPIRY_DAYS = 3650;

/**
 * How stale `last_used_at` may be.
 *
 * Writing it on every request turns a read-only API call into a disk write,
 * which is how a token used in a loop becomes a performance problem. A minute
 * is far below the resolution anybody reads it at.
 */
const USE_WRITE_INTERVAL_MS = 60 * 1000;

/** How often the same refused token is worth another line in the log. */
const REFUSAL_REPORT_INTERVAL_MS = 60 * 60 * 1000;

/** A tombstone outlives the question it answers by this much, then goes. */
const TOMBSTONE_DAYS = 90;

const cleanName = (name, fallback) => {
  const text = String(name ?? '')
    .replace(CONTROL_CHARACTERS, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return text || fallback;
};

/**
 * The stored form of the secret half.
 *
 * SHA-256 and not bcrypt, deliberately. A password is short, guessable and
 * typed by a person, so it needs a hash that is slow on purpose; this secret
 * is 256 bits drawn from the system's random source, and no amount of hardware
 * turns that into a dictionary. What it does need is to be fast enough to run
 * on every request without becoming the cost of the API.
 *
 * No salt, for the same reason: salts defeat precomputation against guessable
 * inputs, and there is nothing to precompute against 2^256.
 */
const hashSecret = (secret) => crypto.createHash('sha256').update(secret, 'utf8').digest('hex');

/** Compare two hashes without letting the clock say how much of one matched. */
const hashesMatch = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/** base64url, because a token is pasted into shells and configuration files. */
const randomSecret = () => crypto.randomBytes(SECRET_BYTES).toString('base64url');

const randomTokenId = () => crypto.randomBytes(ID_BYTES).toString('hex');

/**
 * Take a token value apart, if it is one.
 *
 * Strict on purpose: anything that is not exactly this shape is refused here,
 * before it reaches a query. The identifier is matched as hexadecimal, so
 * nothing else can ever be handed to the database as one.
 */
const parseToken = (value) => {
  if (typeof value !== 'string') return null;
  const matched = TOKEN_PATTERN.exec(value);
  if (!matched) return null;
  return { id: matched[1], secret: matched[2] };
};

/** What a token looks like to its owner. The secret is never in here. */
const publicShape = (row) => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  createdAt: row.created_at,
  expiresAt: row.expires_at || null,
  lastUsedAt: row.last_used_at || null,
  lastUsedIp: row.last_used_ip || null,
});

const isExpired = (row, at = nowIso()) => Boolean(row.expires_at) && row.expires_at <= at;

/** Every live token on an account, newest first. */
const listTokens = async (userId) => {
  const db = await getDb();
  return db
    .prepare(
      'SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
    )
    .all(userId)
    .map(publicShape);
};

const countTokens = async (userId) => {
  const db = await getDb();
  return db
    .prepare('SELECT COUNT(*) FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL')
    .pluck()
    .get(userId);
};

/**
 * When a token stops working, from a number of days.
 *
 * `null` means never, which is what most scripts want and what the interface
 * offers as a choice rather than as a default nobody read.
 */
const expiryFromDays = (days) => {
  if (days === null || days === undefined || days === '') return null;
  const number = Number(days);
  if (!Number.isFinite(number)) return undefined;
  const whole = Math.floor(number);
  if (whole <= 0 || whole > MAX_EXPIRY_DAYS) return undefined;
  return new Date(Date.now() + whole * 24 * 60 * 60 * 1000).toISOString();
};

/**
 * Make one.
 *
 * The only moment the value exists in readable form: it is returned here, and
 * what the table keeps is a hash of half of it. Losing it costs a new token,
 * which is the point — a credential that can be read back is one that can be
 * read by somebody else.
 */
const mintToken = async ({ userId, name, scope = DEFAULT_SCOPE, expiresInDays = null }) => {
  if (!userId) throw new Error('A token belongs to an account.');
  if (!SCOPES.has(scope)) return { error: 'scope' };

  const expiresAt = expiryFromDays(expiresInDays);
  if (expiresAt === undefined) return { error: 'expiry' };

  const held = await countTokens(userId);
  if (held >= MAX_TOKENS_PER_USER) return { error: 'too-many' };

  const db = await getDb();
  const id = randomTokenId();
  const secret = randomSecret();
  const row = {
    id,
    user_id: userId,
    name: cleanName(name, `Token ${held + 1}`),
    secret_hash: hashSecret(secret),
    scope,
    created_at: nowIso(),
    expires_at: expiresAt,
    last_used_at: null,
    last_used_ip: null,
    revoked_at: null,
  };

  db.prepare(
    `INSERT INTO api_tokens
       (id, user_id, name, secret_hash, scope, created_at, expires_at, last_used_at, last_used_ip, revoked_at)
     VALUES (@id, @user_id, @name, @secret_hash, @scope, @created_at, @expires_at, @last_used_at, @last_used_ip, @revoked_at)`
  ).run(row);

  logger.info({ userId, tokenId: id, scope }, 'An API token was issued');
  return { token: publicShape(row), secret: `${TOKEN_PREFIX}_${id}_${secret}` };
};

const renameToken = async ({ userId, id, name }) => {
  const db = await getDb();
  const row = db
    .prepare('SELECT * FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .get(id, userId);
  if (!row) return null;
  const next = cleanName(name, row.name);
  db.prepare('UPDATE api_tokens SET name = ? WHERE id = ?').run(next, id);
  return publicShape({ ...row, name: next });
};

/**
 * Take one away.
 *
 * The row stays, emptied of everything that could authenticate: a tombstone
 * carries the name and the fact of the revocation, so a token still being
 * presented after it was revoked is recognisable rather than indistinguishable
 * from a typo. The hash is overwritten with a value nothing hashes to, which
 * is what makes the revocation final even if the row is somehow read again.
 */
const revokeToken = async ({ userId, id }) => {
  const db = await getDb();
  const row = db
    .prepare('SELECT * FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .get(id, userId);
  if (!row) return { revoked: false };

  db.prepare('UPDATE api_tokens SET revoked_at = ?, secret_hash = ? WHERE id = ?').run(
    nowIso(),
    'revoked',
    id
  );
  purgeOldTombstones(db, userId);
  logger.info({ userId, tokenId: id }, 'An API token was revoked');
  return { revoked: true, token: publicShape(row) };
};

/** Every token of an account, for somebody handing that account back. */
const revokeAllTokens = async (userId) => {
  const db = await getDb();
  const changes = db
    .prepare(
      "UPDATE api_tokens SET revoked_at = ?, secret_hash = 'revoked' WHERE user_id = ? AND revoked_at IS NULL"
    )
    .run(nowIso(), userId).changes;
  purgeOldTombstones(db, userId);
  return changes;
};

/** A tombstone answers a question for a season, not for ever. */
const purgeOldTombstones = (db, userId) => {
  const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'DELETE FROM api_tokens WHERE user_id = ? AND revoked_at IS NOT NULL AND revoked_at < ?'
  ).run(userId, cutoff);
};

/**
 * Who is calling, if this is a token at all.
 *
 * Every refusal answers the same way to the caller — see the route — but says
 * here which of the four it was, because the difference between "gibberish"
 * and "the token you revoked on Tuesday" is the whole value of the log line.
 */
const authenticateToken = async (value) => {
  const parsed = parseToken(value);
  if (!parsed) return { ok: false, reason: 'malformed' };

  const db = await getDb();
  const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(parsed.id);
  if (!row) return { ok: false, reason: 'unknown' };

  // A revoked row is answered before its hash is looked at, and holds no hash
  // that could match in any case — the revocation overwrote it. Both, rather
  // than either: the first is what lets the log say "the token you revoked is
  // still being used", the second is what makes the revocation final even if
  // some later path forgets to ask. Nothing is given away by answering early,
  // because every refusal reaches the caller as the same 401.
  if (row.revoked_at) return { ok: false, reason: 'revoked', tokenId: row.id, name: row.name };

  const presented = hashSecret(parsed.secret);
  if (!hashesMatch(presented, row.secret_hash)) {
    return { ok: false, reason: 'unknown' };
  }

  if (isExpired(row)) return { ok: false, reason: 'expired', tokenId: row.id, name: row.name };

  return {
    ok: true,
    userId: row.user_id,
    tokenId: row.id,
    name: row.name,
    scope: SCOPES.has(row.scope) ? row.scope : DEFAULT_SCOPE,
  };
};

/**
 * When a token was last used, and from where — written at most once a minute.
 *
 * Kept in memory rather than read back from the row, so the throttle costs
 * nothing: the map holds one entry per token actually in use, and a restart
 * costs one extra write.
 */
const lastWriteAt = new Map();

const noteUse = async ({ tokenId, address }) => {
  const now = Date.now();
  const previous = lastWriteAt.get(tokenId);
  if (previous && now - previous < USE_WRITE_INTERVAL_MS) return false;
  lastWriteAt.set(tokenId, now);

  try {
    const db = await getDb();
    db.prepare('UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(
      nowIso(),
      address || null,
      tokenId
    );
    return true;
  } catch (error) {
    // A token that works does not stop working because its last-used stamp
    // could not be written.
    logger.debug({ err: error, tokenId }, 'Could not record an API token use');
    return false;
  }
};

/**
 * Whether this refusal is worth a line in the activity log.
 *
 * A revoked token replayed in a loop would otherwise write a row per request,
 * which turns an audit trail into a way to fill a disk. One line an hour per
 * token says everything the first line said, and the map is bounded by the
 * number of distinct tokens anybody bothers to replay.
 */
const refusalReportedAt = new Map();
const MAX_TRACKED_REFUSALS = 500;

const shouldReportRefusal = (tokenId) => {
  if (!tokenId) return false;
  const now = Date.now();
  const previous = refusalReportedAt.get(tokenId);
  if (previous && now - previous < REFUSAL_REPORT_INTERVAL_MS) return false;

  if (refusalReportedAt.size >= MAX_TRACKED_REFUSALS) {
    for (const [key, at] of refusalReportedAt) {
      if (now - at >= REFUSAL_REPORT_INTERVAL_MS) refusalReportedAt.delete(key);
    }
    // Still full of recent entries: forget the oldest rather than grow.
    if (refusalReportedAt.size >= MAX_TRACKED_REFUSALS) {
      const oldest = refusalReportedAt.keys().next().value;
      refusalReportedAt.delete(oldest);
    }
  }

  refusalReportedAt.set(tokenId, now);
  return true;
};

/** Start again, for tests that own the clock. */
const forgetUseThrottles = () => {
  lastWriteAt.clear();
  refusalReportedAt.clear();
};

module.exports = {
  DEFAULT_SCOPE,
  MAX_EXPIRY_DAYS,
  MAX_NAME_LENGTH,
  MAX_TOKENS_PER_USER,
  SCOPES,
  TOKEN_PATTERN,
  TOKEN_PREFIX,
  authenticateToken,
  countTokens,
  forgetUseThrottles,
  hashSecret,
  listTokens,
  mintToken,
  noteUse,
  parseToken,
  renameToken,
  revokeAllTokens,
  revokeToken,
  shouldReportRefusal,
};
