const fs = require('fs/promises');

/**
 * Make sure a folder is there, and say what had to be created for it.
 *
 * `mkdir` with `recursive` answers the topmost folder it created, or nothing
 * when they all existed already — which is what tells an operation that fails
 * later exactly what it added, and nothing more.
 */
const ensureDir = async (targetPath) => fs.mkdir(targetPath, { recursive: true });

const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_) {
    return false;
  }
};

module.exports = {
  ensureDir,
  pathExists,
};
