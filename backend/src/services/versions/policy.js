/**
 * Which earlier versions of a file are worth keeping.
 *
 * Pure functions, like the trash's own policy: no disk, no database, no clock.
 * The capture and the maintenance pass gather the facts; this only decides, so
 * the rules can be checked against thousands of histories in the time one
 * disk-backed test takes.
 *
 * Two decisions live here.
 *
 *   - Thinning over time. Everything from the last hours is kept; older than
 *     that, one version an hour, then one a day, then one a week, and never
 *     more than a set number per file. The newest version in each hour, day or
 *     week is the one kept, so running the rule again on what it kept changes
 *     nothing. A pinned version is outside the rule altogether.
 *
 *   - One version per editing session. An office editor saves on its own every
 *     few seconds; keeping each of those would fill a volume with near copies
 *     of the same document. What is worth keeping is the document as it was
 *     before the session started, a checkpoint now and then during a long one,
 *     and whatever someone saved on purpose.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const byNewest = (left, right) =>
  right.modifiedAt - left.modifiedAt || String(left.id).localeCompare(String(right.id));

/** The hour, day or week a version falls in once it is that old, or null while everything is kept. */
const bucketOf = (modifiedAt, now, { keepAllHours, hourlyDays, dailyDays }) => {
  const age = Math.max(0, now - modifiedAt);
  if (age < keepAllHours * HOUR_MS) return null;
  if (age < hourlyDays * DAY_MS) return `h${Math.floor(modifiedAt / HOUR_MS)}`;
  if (age < dailyDays * DAY_MS) return `d${Math.floor(modifiedAt / DAY_MS)}`;
  return `w${Math.floor(modifiedAt / WEEK_MS)}`;
};

/**
 * The versions of one file the rule lets go, and why: `thinned` when a newer
 * version already stands for the same hour, day or week, `limit` when the file
 * keeps more than it may.
 *
 * @param {object} input
 * @param {{ id: string, modifiedAt: number, pinned?: boolean }[]} input.versions
 * @param {number} input.now  milliseconds since the epoch
 * @param {{ keepAllHours: number, hourlyDays: number, dailyDays: number, maxPerFile: number }} input.settings
 * @returns {{ id: string, reason: 'thinned'|'limit' }[]}
 */
const thinVersions = ({ versions = [], now, settings }) => {
  const drop = [];
  const seen = new Set();
  const kept = [];
  for (const version of versions.filter((entry) => !entry.pinned).sort(byNewest)) {
    const bucket = bucketOf(version.modifiedAt, now, settings);
    if (bucket !== null && seen.has(bucket)) {
      drop.push({ id: version.id, reason: 'thinned' });
      continue;
    }
    if (bucket !== null) seen.add(bucket);
    kept.push(version);
  }
  const limit = Math.max(1, Math.floor(settings.maxPerFile));
  for (const version of kept.slice(limit)) drop.push({ id: version.id, reason: 'limit' });
  return drop;
};

/**
 * Whether the content a save is about to replace becomes a version.
 *
 * @param {object} input
 * @param {object|null} input.history  what was recorded about the file's current content, or null
 * @param {boolean} input.fingerprintMatches  whether the file on disk is still the content recorded
 * @param {{ key?: string|null }|null} input.session  the editing session the save belongs to
 * @param {number} input.now
 * @param {number} input.checkpointMinutes
 * @returns {'keep'|'skip'}
 */
const sessionDecision = ({ history, fingerprintMatches, session, now, checkpointMinutes }) => {
  // Nothing known about the content, or it changed outside the application:
  // whatever it is, it was not written by this session.
  if (!history || !fingerprintMatches) return 'keep';
  // A save that belongs to no session — the text editor — is a save on purpose.
  if (!session?.key) return 'keep';
  // The document as it was before this session.
  if (history.currentSession !== session.key) return 'keep';
  // A state someone saved on purpose, about to be overwritten by the next save.
  if (history.currentExplicit) return 'keep';
  const checkpoint = Date.parse(history.sessionCheckpointAt || '');
  if (!Number.isFinite(checkpoint)) return 'keep';
  return now - checkpoint >= checkpointMinutes * MINUTE_MS ? 'keep' : 'skip';
};

/**
 * Whether a save comes from an editing session that started before the file
 * was restored to an earlier version. Such a session still holds the content
 * the restore replaced: written over the file, it would undo the restore
 * without anyone noticing, so it is kept as a version instead.
 *
 * Compared to the second: a session is known by when its token was signed,
 * which a token records in whole seconds. An editor reopened in the same second
 * as the restore therefore counts as opened after it — the other way round
 * would send a fresh session's work into the history instead of the file.
 */
const isStaleSave = ({ history, session }) => {
  const restoredAt = Date.parse(history?.restoredAt || '');
  // An unknown start is not the epoch: `Number(null)` is 0, which would set
  // aside every save of a session that cannot say when it began.
  if (session?.startedAt === null || session?.startedAt === undefined) return false;
  const startedAt = Number(session.startedAt);
  if (!Number.isFinite(restoredAt) || !Number.isFinite(startedAt)) return false;
  return Math.floor(startedAt / 1000) < Math.floor(restoredAt / 1000);
};

module.exports = {
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  WEEK_MS,
  bucketOf,
  thinVersions,
  sessionDecision,
  isStaleSave,
};
