const config = require('../config');
const { normalizeRelativePath } = require('../utils/pathUtils');

/**
 * Folders the search index has no business reading.
 *
 * The same shape as the folder-size exclusions, and deliberately so: one list
 * comes from the environment and cannot be edited from the interface, the
 * other belongs to whoever administers the instance. An operator who wrote a
 * path into their compose file did not mean for it to be removable by anyone
 * who can reach Settings.
 *
 * Nothing is excluded by default. With the index answering in place of the
 * live content scan, a folder left out is a folder that cannot be found by
 * what is inside it — that decision belongs to whoever owns the volume, not to
 * a list of names someone thought looked like noise.
 */

const SETTINGS_CATEGORY = 'system';
const SETTINGS_KEY = 'searchIndex';

let adminPaths = [];

const unique = (paths) => [...new Set(paths)].sort((left, right) => left.localeCompare(right));

const sanitizePaths = (value) => {
  const values = Array.isArray(value)
    ? value
    : String(value || '')
        .split(/[\n,]/)
        .map((item) => item.trim());

  return unique(
    values
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => normalizeRelativePath(item))
      .filter(Boolean)
  );
};

const environmentPaths = () => sanitizePaths(config.search?.index?.exclude || []);

const effectivePaths = () => unique([...environmentPaths(), ...adminPaths]);

const loadFromDatabase = (db) => {
  const row = db
    .prepare('SELECT value FROM system_settings WHERE category = ? AND key = ?')
    .get(SETTINGS_CATEGORY, SETTINGS_KEY);
  if (!row) {
    adminPaths = [];
    return adminPaths;
  }
  try {
    adminPaths = sanitizePaths(JSON.parse(row.value)?.excludedPaths || []);
  } catch {
    adminPaths = [];
  }
  return adminPaths;
};

const setAdminPaths = (paths) => {
  const previous = effectivePaths();
  const environment = environmentPaths();
  adminPaths = sanitizePaths(paths).filter((value) => !environment.includes(value));
  const next = effectivePaths();
  return {
    excludedPaths: adminPaths,
    environmentExcludedPaths: environmentPaths(),
    added: next.filter((value) => !previous.includes(value)),
    removed: previous.filter((value) => !next.includes(value)),
  };
};

const snapshot = () => ({
  excludedPaths: adminPaths,
  environmentExcludedPaths: environmentPaths(),
});

module.exports = {
  SETTINGS_CATEGORY,
  SETTINGS_KEY,
  sanitizePaths,
  loadFromDatabase,
  setAdminPaths,
  effectivePaths,
  snapshot,
};
