const crypto = require('crypto');

/**
 * A selection, resolved once, taken away in several requests.
 *
 * Downloading a selection without zipping it means one request per file, and a
 * request per file is a counter per file: a public link downloaded once as
 * eleven files would have read eleven downloads, and the activity log eleven
 * lines for one gesture. That is not what either of them is asking.
 *
 * So the selection is resolved, checked and *counted* once, here, and what
 * comes back is a token naming the parts. Taking a part proves nothing about
 * access on its own — each one is resolved and checked again when it is
 * fetched — the token only says "this is the same download, already counted".
 *
 * Plans live in memory and nowhere else. They are worth minutes, not restarts:
 * a lost plan costs a second click, and a plan surviving a restart would be a
 * permission decision surviving the process that made it.
 */

/**
 * How long a plan stays usable after it was last touched, rather than after it
 * was made: twenty-five files of a gigabyte each are a long download and a
 * perfectly ordinary one, and a fixed deadline would cut it in the middle.
 */
const IDLE_MS = 10 * 60 * 1000;

/** A bound on what an unattended process can accumulate. Oldest first out. */
const MAX_PLANS = 200;

const plans = new Map();

/**
 * Who a plan belongs to.
 *
 * An account, or the guest session that proves a share's password was typed.
 * A token is useless to anybody else: the parts are fetched with the same
 * credentials the plan was made with, and a plan read by another requester is
 * treated as absent.
 */
const ownerKeyFor = (req) => {
  if (req?.guestSession?.id) return `guest:${req.guestSession.id}`;
  if (req?.user?.id) return `user:${req.user.id}`;
  return null;
};

const sweep = (now = Date.now()) => {
  for (const [token, plan] of plans) {
    if (now - plan.lastUsedAt > IDLE_MS) plans.delete(token);
  }

  // Map iterates in insertion order, so the first keys are the oldest made.
  while (plans.size > MAX_PLANS) {
    const oldest = plans.keys().next();
    if (oldest.done) break;
    plans.delete(oldest.value);
  }
};

/**
 * Names that can sit side by side in one folder.
 *
 * A selection can hold two files called `notes.txt` — from a search, or from
 * two folders — and unzipped they land in the same place. The second would
 * have replaced the first without a word. Suffixed here, once, so that both
 * the folder the browser writes into and the folder the reader picks get the
 * same set of names.
 */
const withDistinctNames = (files) => {
  const taken = new Map();
  return files.map((file) => {
    const key = file.name.toLowerCase();
    const seen = taken.get(key) || 0;
    taken.set(key, seen + 1);
    if (seen === 0) return file;

    const dot = file.name.lastIndexOf('.');
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const extension = dot > 0 ? file.name.slice(dot) : '';
    return { ...file, name: `${stem} (${seen})${extension}` };
  });
};

const createPlan = ({ ownerKey, basePath = '', files = [], archive = null }) => {
  if (!ownerKey) throw new Error('A download plan needs an owner.');

  sweep();

  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  plans.set(token, {
    ownerKey,
    basePath,
    files: withDistinctNames(files),
    archive,
    createdAt: now,
    lastUsedAt: now,
  });

  return token;
};

/**
 * The plan behind a token, for this requester, or null.
 *
 * Reading it counts as using it: a download in progress keeps its own plan
 * alive.
 */
const readPlan = (token, ownerKey) => {
  if (!token || !ownerKey) return null;
  const plan = plans.get(token);
  if (!plan) return null;

  const now = Date.now();
  if (now - plan.lastUsedAt > IDLE_MS) {
    plans.delete(token);
    return null;
  }

  if (plan.ownerKey !== ownerKey) return null;

  plan.lastUsedAt = now;
  return plan;
};

/** Tests reach for this; nothing in the application does. */
const resetPlans = () => plans.clear();

module.exports = { createPlan, readPlan, ownerKeyFor, resetPlans, IDLE_MS, MAX_PLANS };
