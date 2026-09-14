/**
 * The trash as the rest of the application sees it.
 *
 * The modules beside this one keep the disk and the books in agreement; this
 * one decides who is asking and what they may do:
 *
 *   - a deletion is recorded against the account that made it, and against
 *     the owner of the personal folder or share it came from;
 *   - each person sees what they deleted and what came from their own folder
 *     or shares; an administrator sees everything;
 *   - restoring puts something back where its owner can reach it, so someone
 *     who has since lost write access to that place cannot restore into it;
 *   - share visitors have no trash: what they delete goes to the owner's.
 */
const fsp = require('fs/promises');
const path = require('path');

const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require('../../errors/AppError');
const logger = require('../../utils/logger');
const { ACTIONS, authorizePath } = require('../authorizationService');
const { getDb } = require('../db');
const folderSizeHooks = require('../folderSizeHooks');
const maintenance = require('./maintenance');
const operations = require('./operations');
const { DAY_MS, admission } = require('./policy');
const { getTrashSettings } = require('./settings');
const store = require('./store');
const { verifyZone } = require('./verify');
const zones = require('./zones');

const MAX_IDS = 1000;

const isAdmin = (user) => Array.isArray(user?.roles) && user.roles.includes('admin');

const labelOf = (user) => user?.displayName || user?.username || user?.email || null;

const requireUser = (context) => {
  const user = context?.user;
  if (!user?.id) throw new ForbiddenError('The trash belongs to signed-in accounts.');
  return user;
};

const validateIds = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('At least one trash item is required.');
  }
  if (ids.length > MAX_IDS) {
    throw new ValidationError(`At most ${MAX_IDS} trash items can be handled at once.`);
  }
  if (!ids.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new ValidationError('Trash item ids must be strings.');
  }
  return [...new Set(ids)];
};

const parentOf = (relative) => {
  const parent = path.posix.dirname(relative || '');
  return parent === '.' ? '' : parent;
};

/**
 * Who a deletion is recorded against. A share visitor has no account: the
 * item is theirs to have deleted but the owner's to see.
 */
const attributionFor = (context, target) => {
  const user = context?.user?.id ? context.user : null;
  let ownerUserId = null;
  if (target.space === 'personal') ownerUserId = user?.id || null;
  else if (target.space === 'share') ownerUserId = target.shareInfo?.ownerId || null;
  return {
    logicalPath: target.relativePath || null,
    space: target.space || null,
    deletedBy: user?.id || null,
    deletedByLabel: user ? labelOf(user) : context?.guestSession ? 'share-link' : null,
    ownerUserId,
  };
};

/** Budgets by zone root, measured once for a whole selection. */
const budgetResolver = (settings) => {
  const budgets = new Map();
  return (root) => {
    if (!budgets.has(root)) {
      budgets.set(
        root,
        maintenance.limitsFor(root, settings).then((limits) => limits.budgetBytes)
      );
    }
    return budgets.get(root);
  };
};

/**
 * What deleting these targets would do, told before anyone confirms: into the
 * trash, or gone for good and why. A folder's size is only known once it is
 * measured, which the deletion itself does; if it turns out too large then,
 * it is left where it is and the person is asked again.
 */
const describeTargets = async (targets) => {
  const settings = await getTrashSettings();
  const base = { enabled: settings.enabled, retentionDays: settings.retentionDays };
  if (!settings.enabled) {
    return {
      ...base,
      items: targets.map((target) => ({
        path: target.relativePath,
        disposition: 'permanent',
        reason: 'disabled',
      })),
    };
  }

  const budgetFor = budgetResolver(settings);
  const items = await Promise.all(
    targets.map(async (target) => {
      const entry = { path: target.relativePath, disposition: 'trash', reason: null };
      const located = await zones.locateZoneRoot(target.absolutePath);
      if (!located.root) return { ...entry, disposition: 'permanent', reason: located.reason };
      try {
        if (!(await zones.sameDevice(located.root, target.absolutePath))) {
          return { ...entry, disposition: 'permanent', reason: 'other-device' };
        }
        const stats = await fsp.lstat(target.absolutePath);
        if (
          !stats.isDirectory() &&
          admission({ size: stats.size, budgetBytes: await budgetFor(located.root) }) ===
            'too-large'
        ) {
          return { ...entry, disposition: 'permanent', reason: 'too-large' };
        }
      } catch {
        // Gone already, or unreadable: the deletion itself will say.
      }
      return entry;
    })
  );
  return { ...base, items };
};

/** Put one resolved, authorized target in the trash. */
const trashTarget = async (target, context, { budgetFor } = {}) => {
  const result = await operations.moveToTrash(
    { absolutePath: target.absolutePath, ...attributionFor(context, target) },
    { budgetFor }
  );
  if (result.status === 'trashed') maintenance.requestPass();
  return result;
};

const visibleTo = (item, user) =>
  isAdmin(user) || item.deletedBy === user.id || item.ownerUserId === user.id;

/**
 * A folder this person can open to see a restored item, when there is one: the
 * folder the item was in or, for an entry restored from inside a deleted
 * folder, the folder that entry is back in.
 */
const openPathFor = (item, zone, user, entry = null) => {
  const folderOf = (relative) =>
    entry === null ? parentOf(relative) : path.posix.join(relative, parentOf(entry));
  if (item.deletedBy === user.id && item.space !== 'share' && item.logicalPath) {
    return folderOf(item.logicalPath);
  }
  if (!zone) return null;
  const { kind, name } = zones.describeZoneRoot(zone.root);
  const parent = folderOf(item.relativePath);
  if (kind === 'personal' && item.ownerUserId === user.id) {
    return parent ? `personal/${parent}` : 'personal';
  }
  if (kind === 'volume' && isAdmin(user)) return parent ? `${name}/${parent}` : name;
  return null;
};

const present = (item, zone, user, settings, available) => ({
  id: item.id,
  name: item.name,
  kind: item.kind,
  size: item.size,
  deletedAt: item.deletedAt,
  expiresAt: new Date(Date.parse(item.deletedAt) + settings.retentionDays * DAY_MS).toISOString(),
  deletedBy: {
    id: item.deletedBy,
    label: item.deletedByLabel,
    isYou: Boolean(item.deletedBy) && item.deletedBy === user.id,
  },
  location: zone
    ? { ...zones.describeZoneRoot(zone.root), parent: parentOf(item.relativePath) }
    : null,
  openPath: openPathFor(item, zone, user),
  available,
});

/** What this person's trash holds, newest first. */
const listItems = async (context) => {
  const user = requireUser(context);
  const settings = await getTrashSettings();
  const db = await getDb();
  const zoneRows = new Map(store.listZones(db).map((zone) => [zone.id, zone]));
  const availability = new Map();
  const items = [];

  for (const item of store.listItems(db)) {
    if (item.state !== 'trashed' || !visibleTo(item, user)) continue;
    const zone = zoneRows.get(item.zoneId) || null;
    if (!availability.has(item.zoneId)) {
      // eslint-disable-next-line no-await-in-loop
      availability.set(item.zoneId, zone ? (await zones.inspectZone(zone)).available : false);
    }
    items.push(present(item, zone, user, settings, availability.get(item.zoneId)));
  }

  return { enabled: settings.enabled, retentionDays: settings.retentionDays, items };
};

/**
 * Whether this person may put the item back. An administrator may; the owner
 * of the personal folder or share it came from may; the person who deleted it
 * may, as long as they can still write where it goes back to.
 */
const mayRestore = async (item, context, user) => {
  if (isAdmin(user)) return true;
  if (item.ownerUserId && item.ownerUserId === user.id) return true;
  if (item.deletedBy === user.id && item.logicalPath && item.space !== 'share') {
    const parent = parentOf(item.logicalPath);
    if (!parent) return false;
    const { allowed } = await authorizePath(context, parent, ACTIONS.write);
    return Boolean(allowed);
  }
  return false;
};

const announceRestored = (item, restorePath) => {
  try {
    const pending =
      item.kind === 'directory'
        ? folderSizeHooks.onDirectoryTreeCreated(restorePath)
        : folderSizeHooks.onFileWritten(restorePath, item.size);
    Promise.resolve(pending).catch(() => {});
  } catch (error) {
    logger.debug({ err: error, restorePath }, 'Folder sizes were not told about a restore');
  }
};

const findVisible = (db, id, user) => {
  const item = store.getItem(db, id);
  return item && item.state === 'trashed' && visibleTo(item, user) ? item : null;
};

const restoreItems = async (ids, context) => {
  const user = requireUser(context);
  const db = await getDb();
  const results = [];

  for (const id of validateIds(ids)) {
    const item = findVisible(db, id, user);
    if (!item) {
      results.push({ id, status: 'not-found' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (!(await mayRestore(item, context, user))) {
      results.push({ id, status: 'forbidden', name: item.name });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const outcome = await operations.restoreItem(id);
    if (outcome.status === 'restored') {
      announceRestored(item, outcome.restorePath);
      results.push({
        id,
        status: 'restored',
        name: item.name,
        restoredName: path.basename(outcome.restorePath),
        renamed: outcome.renamed,
        path: openPathFor(item, store.getZone(db, item.zoneId), user),
      });
    } else {
      results.push({ id, status: outcome.status, reason: outcome.reason || null, name: item.name });
    }
  }

  return { items: results };
};

/** A path inside a deleted folder, normalised, or a refusal saying what is wrong with it. */
const validateEntryPath = (entryPath, { allowTop = false } = {}) => {
  const segments = operations.entrySegments(entryPath);
  if (!segments || (!allowTop && segments.length === 0)) {
    throw new ValidationError(
      'A path inside a deleted folder is relative, separated by "/", with no empty, "." or ".." part.'
    );
  }
  return segments.join('/');
};

const validateEntryPaths = (paths) => {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ValidationError('At least one entry of the deleted folder is required.');
  }
  if (paths.length > MAX_IDS) {
    throw new ValidationError(`At most ${MAX_IDS} entries can be restored at once.`);
  }
  const unique = [...new Set(paths.map((entryPath) => validateEntryPath(entryPath)))];
  // A folder brings back what it holds: asking for both would restore one twice over.
  const nested = unique.find((entryPath) =>
    unique.some((other) => entryPath.startsWith(`${other}/`))
  );
  if (nested) {
    throw new ValidationError(`"${nested}" is inside another entry of the same request.`);
  }
  return unique;
};

/** A deleted folder this person can see, including while an entry is on its way out of it. */
const findVisibleFolder = (db, id, user) => {
  const item = typeof id === 'string' && id ? store.getItem(db, id) : null;
  return item && ['trashed', 'extracting'].includes(item.state) && visibleTo(item, user)
    ? item
    : null;
};

/** What a deleted folder holds at a path inside it, for someone who can see it in their trash. */
const listEntries = async (id, entryPath, context) => {
  const user = requireUser(context);
  const normalized = validateEntryPath(entryPath, { allowTop: true });
  const db = await getDb();
  if (!findVisibleFolder(db, id, user)) throw new NotFoundError('This item is not in your trash.');

  const outcome = await operations.listEntries(id, normalized);
  if (outcome.status === 'unavailable') {
    throw new ConflictError('The volume this item was deleted from is not available.');
  }
  if (outcome.status === 'not-directory') throw new ValidationError('This is not a folder.');
  if (outcome.status !== 'listed') {
    throw new NotFoundError('This deleted folder holds nothing at that path.');
  }

  const settings = await getTrashSettings();
  const zone = store.getZone(db, outcome.item.zoneId);
  return {
    item: present(outcome.item, zone, user, settings, true),
    path: normalized,
    entries: outcome.entries,
  };
};

/**
 * Put back entries from inside a deleted folder. Allowed to whoever may restore
 * the folder itself: an entry goes back inside the folder's own original place,
 * so that is the place the right is checked against.
 */
const restoreEntries = async (id, paths, context) => {
  const user = requireUser(context);
  const entries = validateEntryPaths(paths);
  const db = await getDb();
  const item = typeof id === 'string' && id ? findVisible(db, id, user) : null;
  if (!item) throw new NotFoundError('This item is not in your trash.');

  if (!(await mayRestore(item, context, user))) {
    return {
      items: entries.map((entry) => ({
        entry,
        status: 'forbidden',
        name: path.posix.basename(entry),
      })),
    };
  }

  const zone = store.getZone(db, item.zoneId);
  const results = [];
  for (const entry of entries) {
    const name = path.posix.basename(entry);
    let outcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await operations.restoreEntry(item.id, entry);
    } catch (error) {
      logger.warn(
        { err: error, itemId: item.id, entry },
        'An entry could not be restored from a deleted folder'
      );
      outcome = { status: 'failed' };
    }
    if (outcome.status === 'restored') {
      announceRestored(outcome, outcome.restorePath);
      results.push({
        entry,
        status: 'restored',
        name,
        restoredName: path.basename(outcome.restorePath),
        renamed: outcome.renamed,
        path: openPathFor(item, zone, user, entry),
      });
    } else {
      results.push({ entry, status: outcome.status, reason: outcome.reason || null, name });
    }
  }

  return { items: results };
};

/**
 * Remove items for good. An administrator may also forget items whose zone is
 * not there — only their records, never a disk — once they know it is not
 * coming back.
 */
const purgeItems = async (ids, context, { forgetUnavailable = false } = {}) => {
  const user = requireUser(context);
  const db = await getDb();
  const results = [];

  for (const id of validateIds(ids)) {
    const item = findVisible(db, id, user);
    if (!item) {
      results.push({ id, status: 'not-found' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    let outcome = await operations.purgeItem(id);
    if (outcome.status === 'unavailable' && forgetUnavailable && isAdmin(user)) {
      // eslint-disable-next-line no-await-in-loop
      outcome = await operations.forgetItem(id);
    }
    results.push({ id, status: outcome.status, reason: outcome.reason || null, name: item.name });
  }

  return { items: results };
};

/** Everything this person can see in the trash, removed for good. */
const emptyTrash = async (context) => {
  const user = requireUser(context);
  const db = await getDb();
  const summary = { purged: 0, unavailable: 0, failed: 0 };

  for (const item of store.listItems(db)) {
    if (item.state !== 'trashed' || !visibleTo(item, user)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await operations.purgeItem(item.id);
      if (outcome.status === 'purged') summary.purged += 1;
      else if (outcome.status === 'unavailable') summary.unavailable += 1;
    } catch (error) {
      summary.failed += 1;
      logger.warn({ err: error, itemId: item.id }, 'A trash item could not be purged');
    }
  }

  return summary;
};

/** Every zone checked against its invariants, for the administrator's "Verify". */
const verifyAll = async () => {
  const settings = await getTrashSettings();
  const db = await getDb();
  const results = [];
  for (const zone of store.listZones(db)) {
    // eslint-disable-next-line no-await-in-loop
    const inspection = await zones.inspectZone(zone);
    // eslint-disable-next-line no-await-in-loop
    const limits = inspection.available ? await maintenance.limitsFor(zone.root, settings) : {};
    // eslint-disable-next-line no-await-in-loop
    const result = await verifyZone(zone, limits);
    results.push({ ...result, ...zones.describeZoneRoot(zone.root) });
  }
  return { zones: results };
};

module.exports = {
  attributionFor,
  budgetResolver,
  describeTargets,
  trashTarget,
  listItems,
  restoreItems,
  listEntries,
  restoreEntries,
  purgeItems,
  emptyTrash,
  verifyAll,
  zonesOverview: () => maintenance.zonesOverview(),
  runMaintenance: () => maintenance.runPass({ reason: 'administrator' }),
};
