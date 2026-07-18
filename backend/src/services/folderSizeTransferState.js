const path = require('path');

// Coordinates directory trees currently being copied or moved. SQLite keeps
// the pending row; this set prevents refreshes from indexing a partial tree.
const activeDirectories = new Set();

const begin = (absolutePath) => {
  if (absolutePath) activeDirectories.add(absolutePath);
};

const finish = (absolutePath) => {
  if (absolutePath) activeDirectories.delete(absolutePath);
};

const finishAll = (absolutePaths = []) => {
  for (const absolutePath of absolutePaths) finish(absolutePath);
};

const isRelatedToActiveTransfer = (absolutePath) => {
  if (!absolutePath) return false;
  for (const activePath of activeDirectories) {
    if (
      absolutePath === activePath ||
      absolutePath.startsWith(`${activePath}${path.sep}`) ||
      activePath.startsWith(`${absolutePath}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
};

module.exports = { begin, finish, finishAll, isRelatedToActiveTransfer };
