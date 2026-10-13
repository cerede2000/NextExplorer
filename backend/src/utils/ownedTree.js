const fs = require('fs/promises');

const { isUnreachableEntry } = require('./unreachableEntries');
const bytePath = require('./bytePath');

/**
 * What an operation wrote, told apart from what someone else put beside it.
 *
 * Undoing an operation used to mean removing its destination recursively. When
 * someone saved a file into a folder the operation had just created, that file
 * went too. An entry keeps its identity through a rename and a hard link, so
 * what was taken stock of before an entry was put in place is still
 * recognisable there: the undo removes exactly that, and a folder only once it
 * is empty and was one of the operation's own.
 *
 * Nothing here follows a symbolic link: a link is an entry like a file.
 */

/**
 * An entry's identity: its device and inode, and what a rename or a hard link
 * keeps and a new entry would not share.
 *
 * Inode numbers are reused. ext4 gives the number of a file just removed to the
 * next one created, so a file someone wrote under the name of one of the
 * operation's own, after removing it, can carry the same device and inode. The
 * birth time, where the filesystem records one, tells them apart; so do the
 * size and modification time of a file or a link, which a rename keeps. A
 * folder's size and modification time change as entries come and go inside it,
 * so a folder is known by device, inode and birth time alone.
 */
const identityOf = (stats) => {
  const born = stats.birthtimeMs > 0 ? stats.birthtimeMs : 0;
  if (stats.isDirectory()) return `${stats.dev}:${stats.ino}:${born}`;
  return `${stats.dev}:${stats.ino}:${born}:${stats.size}:${stats.mtimeMs}`;
};

/**
 * Every entry under `root`, `root` included, by identity.
 *
 * Read as bytes, so an entry whose name does not decode as UTF-8 is taken stock
 * of like any other and the undo can remove exactly what the operation wrote.
 * Walking it as text used to throw, taking the whole extraction with it.
 *
 * An entry nothing can reach at all is still left out, which is the safe way
 * round: the undo removes what it is sure it wrote, and anything it could not
 * identify stays, reported by `removeInventoried` as kept.
 */
const takeInventory = async (root) => {
  const owned = new Set();

  const walk = async (entryPath) => {
    let stats;
    try {
      stats = await fs.lstat(entryPath);
    } catch (error) {
      if (!isUnreachableEntry(error)) throw error;
      return;
    }
    owned.add(identityOf(stats));
    if (!stats.isDirectory()) return;
    let names;
    try {
      names = await fs.readdir(entryPath, { encoding: 'buffer' });
    } catch (error) {
      if (!isUnreachableEntry(error)) throw error;
      return;
    }
    for (const name of names) {
      await walk(bytePath.join(entryPath, name));
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
      if (!isUnreachableEntry(error)) throw error;
      // Cannot be identified, so it cannot be one of the operation's own: it
      // stays, and is reported as kept.
      kept.push(entryPath);
      return;
    }
    const ours = inventory.has(identityOf(stats));

    if (!stats.isDirectory()) {
      if (ours) await fs.unlink(entryPath).catch(ignoreGone);
      else kept.push(entryPath);
      return;
    }

    let names;
    try {
      names = await fs.readdir(entryPath, { encoding: 'buffer' });
    } catch (error) {
      if (!isUnreachableEntry(error)) throw error;
      // Nothing inside can be looked at, so nothing inside is removed and the
      // folder is kept: it is not empty as far as anyone here can tell.
      kept.push(entryPath);
      return;
    }
    for (const name of names) {
      await visit(bytePath.join(entryPath, name));
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

module.exports = { identityOf, takeInventory, removeInventoried };
