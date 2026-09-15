const fs = require('fs/promises');
const path = require('path');

/**
 * What an operation wrote, told apart from what someone else put beside it.
 *
 * Undoing an operation used to mean removing its destination recursively. When
 * someone saved a file into a folder the operation had just created, that file
 * went too. An entry keeps its device and inode through a rename and a hard
 * link, so what was taken stock of before an entry was put in place is still
 * recognisable there: the undo removes exactly that, and a folder only once it
 * is empty and was one of the operation's own.
 *
 * Nothing here follows a symbolic link: a link is an entry like a file.
 */

const keyOf = (stats) => `${stats.dev}:${stats.ino}`;

/** Every entry under `root`, `root` included, by device and inode. */
const takeInventory = async (root) => {
  const owned = new Set();
  const walk = async (entryPath) => {
    const stats = await fs.lstat(entryPath);
    owned.add(keyOf(stats));
    if (!stats.isDirectory()) return;
    for (const name of await fs.readdir(entryPath)) {
      // eslint-disable-next-line no-await-in-loop
      await walk(path.join(entryPath, name));
    }
  };
  await walk(root);
  return owned;
};

/**
 * Remove what `inventory` lists under `root`, and nothing else. A file or link
 * goes when it is one of the inventory's; a folder goes when it is one of the
 * inventory's and nothing is left in it. Answers what stayed because it was
 * not the operation's own. Never throws for an entry already gone.
 */
const removeInventoried = async (root, inventory) => {
  const kept = [];
  const visit = async (entryPath) => {
    let stats;
    try {
      stats = await fs.lstat(entryPath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const ours = inventory.has(keyOf(stats));

    if (!stats.isDirectory()) {
      if (ours) await fs.unlink(entryPath).catch(ignoreGone);
      else kept.push(entryPath);
      return;
    }

    for (const name of await fs.readdir(entryPath)) {
      // eslint-disable-next-line no-await-in-loop
      await visit(path.join(entryPath, name));
    }
    if (!ours) {
      kept.push(entryPath);
      return;
    }
    try {
      await fs.rmdir(entryPath);
    } catch (error) {
      // Something that is not the operation's own is still inside.
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST' && error.code !== 'ENOENT') {
        throw error;
      }
    }
  };
  await visit(root);
  return kept;
};

function ignoreGone(error) {
  if (error.code !== 'ENOENT') throw error;
}

module.exports = { takeInventory, removeInventoried };
