const fs = require('fs/promises');
const { constants } = require('fs');

/**
 * Whether the server can write in a folder, asked of the system itself.
 *
 * The permissions a listing reports come from the accounts, the rules and the
 * shares — none of which knows how the storage was mounted. A volume bound
 * `:ro` in a compose file, or owned by a user the container does not run as,
 * was offered New folder, Upload and Delete like any other, and every one of
 * them ended in the system's own refusal (`EROFS`, `EACCES`) after the person
 * had already chosen what to do (nxzai/NextExplorer#407).
 *
 * One `access(2)` call: it answers for the folder as the server's process
 * sees it, which is the only view that decides whether a write can succeed.
 * For root it passes whatever the mode bits say, except on a read-only mount,
 * which is exactly how a write by root would go too.
 *
 * @param {string} absoluteDir
 * @returns {Promise<null|'storage'|'permission'>} why nothing can be written
 *   there, or null when something can — or when the answer is not one of the
 *   two it knows, since hiding actions on a guess is worse than letting the
 *   write explain itself.
 */
const whyNotWritable = async (absoluteDir) => {
  if (!absoluteDir) return null;
  try {
    await fs.access(absoluteDir, constants.W_OK);
    return null;
  } catch (error) {
    if (error?.code === 'EROFS') return 'storage';
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission';
    return null;
  }
};

/** The permissions that need to write in the folder itself. */
const WRITE_PERMISSIONS = ['canWrite', 'canUpload', 'canDelete', 'canCreateFolder'];

/**
 * An access answer with the writes taken away when the storage refuses them,
 * and the reason beside it — for everyone, administrators included, since no
 * role gets a write past the system.
 *
 * Asked only when the account could write there: when it cannot, the storage
 * has nothing to add and is not asked.
 */
const withStorage = async (access, absoluteDir) => {
  if (!access || !WRITE_PERMISSIONS.some((key) => access[key])) return access;
  const readOnly = await whyNotWritable(absoluteDir);
  if (!readOnly) return access;
  const restricted = { ...access, readOnly };
  for (const key of WRITE_PERMISSIONS) restricted[key] = false;
  return restricted;
};

module.exports = { whyNotWritable, withStorage, WRITE_PERMISSIONS };
