const path = require('path');

const config = require('../config');
const { normalizeRelativePath } = require('../utils/pathUtils');

const SETTINGS_CATEGORY = 'system';
const SETTINGS_KEY = 'folderSize';

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

const environmentPaths = () => sanitizePaths(config.folderSize.envExcludedPaths || []);

const effectivePaths = () => unique([...environmentPaths(), ...adminPaths]);

const isExcluded = (absolutePath, scope) => {
  if (!absolutePath || !scope?.root) return false;
  const candidate = path.resolve(absolutePath);
  return effectivePaths().some((relativePath) => {
    const excluded = path.resolve(scope.root, relativePath);
    return candidate === excluded || candidate.startsWith(`${excluded}${path.sep}`);
  });
};

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
  isExcluded,
  snapshot,
};
