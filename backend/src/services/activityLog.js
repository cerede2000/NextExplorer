const { getDb } = require('./db');
const { generateId, nowIso } = require('../utils/ids');
const logger = require('../utils/logger');

/**
 * The activity log: who did what, when, and from where.
 *
 * Off by default, and that is the design rather than a shy default. On a
 * machine one person uses, a record of what that person did all day is weight
 * with no reader; on a server several people share, it is the first thing
 * anybody asks for when a file is gone or a link was handed around. So it is a
 * switch, and everything here is built so that the switch being off costs one
 * settings read and nothing else.
 *
 * Nothing in here may fail a request. Somebody's download does not stop
 * because a log line could not be written, so every failure is swallowed and
 * reported to the server's own log instead. The one thing that would be worse
 * than no audit trail is an audit trail that takes the application down with
 * it.
 */

/** What may be recorded. A closed list: a typo is not a new kind of event. */
const ACTIONS = new Set([
  'sign-in',
  'sign-out',
  'account.password',
  'account.two-factor',
  'account.passkey',
  'admin.user',
  'admin.settings',
  'share.create',
  'share.delete',
  'share.download',
  'share.upload',
  'file.download',
  'file.upload',
  'file.delete',
  'file.restore',
  'file.purge',
]);

const OUTCOMES = new Set(['ok', 'refused']);

/** Long enough for a path and a reason; short enough that nothing here is storage. */
const MAX_TARGET = 1024;
const MAX_DETAIL = 2048;

/** A page of history, and the most anybody may ask for at once. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const settings = async () => {
  // Required lazily: the settings service is a large module, and most of what
  // calls this has no other reason to load it.
  const { getSystemSettings } = require('./settingsService');
  return (await getSystemSettings()).activity;
};

const isEnabled = async () => {
  try {
    return Boolean((await settings()).enabled);
  } catch (error) {
    logger.debug({ err: error }, 'Could not read whether the activity log is on');
    return false;
  }
};

const clamp = (value, max) => {
  const text = value === null || value === undefined ? null : String(value);
  return text && text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * The address the request came from.
 *
 * Express already works this out behind a trusted proxy; what it cannot do is
 * decide whether an operator wants it kept, which is why the whole log is a
 * switch rather than something that happens quietly.
 */
const addressOf = (req) => (req && typeof req.ip === 'string' ? req.ip : null);

/**
 * Write one line, if anybody asked for a log.
 *
 * @returns the row that was written, or null when nothing was.
 */
const record = async ({ action, outcome = 'ok', user, userId, actor, target, detail, req }) => {
  try {
    if (!ACTIONS.has(action)) {
      logger.warn({ action }, 'An activity event named an action nothing knows');
      return null;
    }
    if (!(await isEnabled())) return null;

    const db = await getDb();
    const row = {
      id: generateId(),
      at: nowIso(),
      action,
      outcome: OUTCOMES.has(outcome) ? outcome : 'ok',
      user_id: user?.id || userId || null,
      // Somebody who is not signed in is still somebody: a link opened by a
      // guest is exactly what this log exists to show.
      actor: clamp(actor || user?.username || user?.email || 'guest', 200),
      target: clamp(target, MAX_TARGET),
      detail: detail
        ? clamp(typeof detail === 'string' ? detail : JSON.stringify(detail), MAX_DETAIL)
        : null,
      ip: addressOf(req),
    };

    db.prepare(
      `INSERT INTO activity_events (id, at, action, outcome, user_id, actor, target, detail, ip)
       VALUES (@id, @at, @action, @outcome, @user_id, @actor, @target, @detail, @ip)`
    ).run(row);
    return row;
  } catch (error) {
    // Deliberately swallowed. See the note at the top of this file.
    logger.warn({ err: error, action }, 'An activity event could not be written');
    return null;
  }
};

/**
 * Read it back, newest first.
 *
 * Paged by the moment of the last row rather than by an offset: rows arrive
 * while somebody is reading, and an offset would show one twice or skip one.
 */
const readActivity = async ({ action, userId, outcome, from, to, query, before, limit } = {}) => {
  const db = await getDb();
  const where = [];
  const values = {};

  if (action && ACTIONS.has(action)) {
    where.push('action = @action');
    values.action = action;
  }
  if (userId) {
    where.push('user_id = @userId');
    values.userId = userId;
  }
  if (outcome && OUTCOMES.has(outcome)) {
    where.push('outcome = @outcome');
    values.outcome = outcome;
  }
  if (from) {
    where.push('at >= @from');
    values.from = String(from);
  }
  if (to) {
    where.push('at <= @to');
    values.to = String(to);
  }
  if (query) {
    where.push('(actor LIKE @query OR target LIKE @query)');
    values.query = `%${String(query).slice(0, 200)}%`;
  }
  if (before) {
    where.push('at < @before');
    values.before = String(before);
  }

  const size = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const events = db
    .prepare(
      `SELECT * FROM activity_events
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY at DESC, rowid DESC
       LIMIT ${size + 1}`
    )
    .all(values);

  const page = events.slice(0, size);
  return {
    events: page.map((row) => ({
      id: row.id,
      at: row.at,
      action: row.action,
      outcome: row.outcome,
      userId: row.user_id,
      actor: row.actor,
      target: row.target,
      detail: row.detail,
      ip: row.ip,
    })),
    // The moment to ask from next, or null when there is nothing more.
    nextBefore: events.length > size ? page[page.length - 1].at : null,
  };
};

const countActivity = async () => {
  const db = await getDb();
  return db.prepare('SELECT COUNT(*) AS total FROM activity_events').get().total;
};

/**
 * Forget what is older than the retention.
 *
 * Runs whether the log is on or off: switching it off should let the disk go
 * back, not freeze what was written the day before for ever.
 */
const sweepActivity = async () => {
  try {
    const { retentionDays } = await settings();
    const db = await getDb();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const { changes } = db.prepare('DELETE FROM activity_events WHERE at < ?').run(cutoff);
    if (changes > 0) logger.info({ removed: changes }, 'Activity events past their retention');
    return changes;
  } catch (error) {
    logger.warn({ err: error }, 'The activity log could not be swept');
    return 0;
  }
};

/** Everything, at an administrator's request. */
const clearActivity = async () => {
  const db = await getDb();
  return db.prepare('DELETE FROM activity_events').run().changes;
};

module.exports = {
  ACTIONS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clearActivity,
  countActivity,
  isEnabled,
  readActivity,
  record,
  sweepActivity,
};
