const fs = require('fs/promises');
const path = require('path');

const { directories } = require('../config/index');
const { normalizeRelativePath, isInsidePersonalRoot } = require('../utils/pathUtils');
const { getSettings, setSettings } = require('../services/settingsService');

const createPermissionResolver = (rules = []) => {
  const normalizedRules = Array.isArray(rules) ? rules : [];

  return (relativePath) => {
    const rel = normalizeRelativePath(relativePath || '');

    // first match wins
    for (const rule of normalizedRules) {
      const rulePath = normalizeRelativePath(rule.path || '');
      if (!rulePath) continue;

      const matches = rule.recursive
        ? rel === rulePath || rel.startsWith(`${rulePath}/`)
        : rel === rulePath;
      if (matches) return rule.permissions || 'rw';
    }

    return 'rw';
  };
};

// Determine permission for a given relative path: 'rw' | 'ro' | 'hidden'
const getPermissionForPath = async (relativePath) => {
  const settings = await getSettings();
  const rules = Array.isArray(settings?.access?.rules) ? settings.access.rules : [];
  return createPermissionResolver(rules)(relativePath);
};

const getRules = async () => {
  const settings = await getSettings();
  return Array.isArray(settings?.access?.rules) ? settings.access.rules : [];
};

const setRules = async (rules) => {
  const next = await setSettings({
    access: {
      rules: Array.isArray(rules) ? rules : [],
    },
  });
  return next.access.rules;
};

const trimSlashes = (value) => String(value ?? '').replace(/^[\\/]+|[\\/]+$/g, '');

const inVolumes = (relative) => {
  const absolute = path.resolve(directories.volume, relative);
  if (absolute === directories.volume || !absolute.startsWith(directories.volumeWithSep)) {
    return null;
  }
  return isInsidePersonalRoot(absolute) ? null : absolute;
};

/**
 * The same path with each segment as the disk spells it, or null.
 *
 * Read from the listings rather than asked with `stat`, because a disk that
 * ignores case — a Mac's, or a share mounted from one — finds `Torrents` when
 * only `torrents` is there, while a rule compares the two letter for letter and
 * would never match. `exact` asks for the path as typed; otherwise a segment
 * spelled with other capitals is taken when it is the only one that could be
 * meant.
 */
const spelledAsOnDisk = async (segments, { exact = false } = {}) => {
  let current = directories.volume;
  const found = [];
  for (const segment of segments) {
    let entries;
    try {
      entries = await fs.readdir(current);
    } catch {
      return null;
    }
    let name = entries.includes(segment) ? segment : null;
    if (!name && !exact) {
      const alike = entries.filter((entry) => entry.toLowerCase() === segment.toLowerCase());
      if (alike.length === 1) [name] = alike;
    }
    if (!name) return null;
    found.push(name);
    current = path.join(current, name);
  }
  return found.join('/');
};

const kindOf = async (relative) => {
  const segments = relative.split('/').filter(Boolean);
  if (!(await spelledAsOnDisk(segments, { exact: true }))) return 'missing';
  try {
    return (await fs.stat(path.join(directories.volume, ...segments))).isDirectory()
      ? 'folder'
      : 'file';
  } catch {
    return 'missing';
  }
};

/**
 * The folder most likely meant: the path spelled as the disk spells it, or,
 * failing that, with its leading segments taken off one at a time — which is
 * what turns `mnt/torrents` into `torrents`.
 */
const suggestionFor = async (segments) => {
  for (let start = 0; start < segments.length; start += 1) {
    const candidate = await spelledAsOnDisk(segments.slice(start));
    if (candidate && inVolumes(candidate)) return candidate;
  }
  return null;
};

/**
 * What a rule's path names on the disk, for the rule editor to say so.
 *
 * A rule is matched against the path as the application shows it — the volume
 * first, then the folders in it — and nothing checked that one had been typed
 * that way. `mnt/torrents`, written from the compose file's side of the
 * mount, was accepted and matched nothing: a read-only rule that protected no
 * folder at all, with nothing on screen to say so (nxzai/NextExplorer#407).
 *
 * Answered, never refused: a rule may be written for a folder about to be
 * created, and the editor only warns. The access rules are not consulted, so a
 * folder a rule hides is still found — it is the rule that hides it.
 *
 * @returns {Promise<{ path: string, status: 'empty'|'folder'|'file'|'missing'|'invalid', suggestion: string|null }>}
 */
const checkRulePath = async (rawPath) => {
  const typed = typeof rawPath === 'string' ? rawPath : '';
  const answer = (status, suggestion = null) => ({ path: typed, status, suggestion });

  let relative;
  try {
    relative = normalizeRelativePath(trimSlashes(typed));
  } catch {
    return answer('invalid');
  }
  relative = trimSlashes(relative);
  if (!relative) return answer(typed.trim() ? 'invalid' : 'empty');

  if (!inVolumes(relative)) return answer('invalid');

  const kind = await kindOf(relative);
  if (kind !== 'missing') return answer(kind);
  return answer('missing', await suggestionFor(relative.split('/').filter(Boolean)));
};

module.exports = {
  checkRulePath,
  createPermissionResolver,
  getPermissionForPath,
  getRules,
  setRules,
};
