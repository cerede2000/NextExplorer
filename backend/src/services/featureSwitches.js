const config = require('../config/index');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * The two background workers an administrator may switch on from Settings.
 *
 * The search index and the folder sizes used to be decided by the environment
 * alone — `SEARCH_INDEX` and `FOLDER_SIZE_MODE` — so turning either on meant
 * editing a file on the host and restarting, while every other setting beside
 * them was a click (#9).
 *
 * The rule is the one the exclusion lists already follow: the environment is
 * the floor and the interface cannot move it. A variable that is set decides,
 * and Settings shows it and says which one; a variable that is not set leaves
 * the choice to Settings. So an installation configured by file behaves exactly
 * as it did, and one that never touched the file can do it from the page.
 *
 * Only these two, and deliberately. Both start a reader over volumes the server
 * already reads, and grant nothing over the host. The terminal, the paths, the
 * secrets and whether non-administrators see every volume stay in the
 * environment: those widen what an administrator's session can do, and a
 * stolen session should not be able to widen them.
 *
 * Every reader of these two values already goes through the configuration
 * objects, so the effective value is written there and they follow — nothing
 * downstream has to learn a new place to ask.
 */

const FOLDER_SIZE_MODES = ['off', 'shallow', 'full'];

/** What the administrator chose, read once at start and kept in step after. */
const chosen = { searchIndex: false, folderSizeMode: 'off' };

/** Which of the two the environment decided, and so Settings cannot move. */
const locked = () => ({
  searchIndex: env.SEARCH_INDEX_SET === true,
  folderSize: env.FOLDER_SIZE_MODE_SET === true,
});

const validMode = (mode) => (FOLDER_SIZE_MODES.includes(mode) ? mode : 'off');

const effectiveSearchIndex = () =>
  locked().searchIndex ? env.SEARCH_INDEX === true : chosen.searchIndex === true;

const effectiveFolderSizeMode = () =>
  locked().folderSize ? validMode(env.FOLDER_SIZE_MODE) : validMode(chosen.folderSizeMode);

/** Write the effective values where every reader already looks. */
const publish = () => {
  config.search.index.enabled = effectiveSearchIndex();

  const mode = effectiveFolderSizeMode();
  config.folderSize.mode = mode;
  config.folderSize.enabled = mode !== 'off';
  config.features.folderSizeMode = mode;
};

/**
 * Read what Settings holds, before either worker starts.
 *
 * Never throws: a database that cannot be read leaves the environment's
 * answer in place, which is what an installation had before this existed.
 */
const load = async () => {
  try {
    const { getSettings } = require('./settingsService');
    const settings = await getSettings();
    chosen.searchIndex = settings?.searchIndex?.enabled === true;
    chosen.folderSizeMode = validMode(settings?.folderSize?.mode);
  } catch (error) {
    logger.warn({ err: error }, 'Could not read the background switches from Settings');
  }
  publish();
  return snapshot();
};

/** What the page shows: the value in force, and whether it may be moved. */
const snapshot = () => ({
  searchIndex: {
    enabled: effectiveSearchIndex(),
    lockedBy: locked().searchIndex ? 'SEARCH_INDEX' : null,
  },
  folderSize: {
    mode: effectiveFolderSizeMode(),
    lockedBy: locked().folderSize ? 'FOLDER_SIZE_MODE' : null,
  },
});

/**
 * Turn the search index on or off, and act on it.
 *
 * @returns {boolean} whether anything changed
 */
const setSearchIndex = async (enabled) => {
  if (locked().searchIndex) return false;
  const before = effectiveSearchIndex();
  chosen.searchIndex = enabled === true;
  publish();
  const after = effectiveSearchIndex();
  if (before === after) return false;

  const searchIndexManager = require('./searchIndexManager');
  if (after) {
    searchIndexManager.start();
  } else {
    searchIndexManager.stop();
  }
  logger.info({ enabled: after }, 'Search index switched from Settings');
  return true;
};

/**
 * Move the folder sizes between off, shallow and full, and act on it.
 *
 * Between the two measuring modes the worker is stopped and started again: the
 * sizes it holds were computed one way, and the baseline decides from the mode
 * it finds recorded whether they can be kept.
 *
 * @returns {boolean} whether anything changed
 */
const setFolderSizeMode = async (mode) => {
  if (locked().folderSize) return false;
  const before = effectiveFolderSizeMode();
  chosen.folderSizeMode = validMode(mode);
  publish();
  const after = effectiveFolderSizeMode();
  if (before === after) return false;

  const folderSizeManager = require('./folderSizeManager');
  if (before !== 'off') await folderSizeManager.stop();
  if (after !== 'off') folderSizeManager.start();
  logger.info({ from: before, to: after }, 'Folder sizes switched from Settings');
  return true;
};

module.exports = {
  FOLDER_SIZE_MODES,
  load,
  snapshot,
  setSearchIndex,
  setFolderSizeMode,
};
