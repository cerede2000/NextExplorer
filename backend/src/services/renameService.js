const path = require('path');
const fs = require('fs/promises');

const { combineRelativePath, ensureValidName } = require('../utils/pathUtils');
const { pathExists } = require('../utils/fsUtils');
const { ACTIONS, authorizeAndResolve, authorizePath } = require('./authorizationService');
const { ValidationError, ForbiddenError, NotFoundError, ConflictError } = require('../errors/AppError');
const folderSizeHooks = require('./folderSizeHooks');

/**
 * Rename an entry within its own folder.
 *
 * Lives here rather than in the route because two callers need exactly these
 * checks in exactly this order: the file browser, and the ONLYOFFICE editor
 * renaming the document it has open. The second one has to keep its editing
 * session pointing at the file afterwards, which it can only do if the rename
 * reports where the file ended up.
 *
 * @returns {Promise<{absolutePath: string, relativePath: string, name: string,
 *   previousAbsolutePath: string, changed: boolean}>}
 */
const renameEntry = async ({ context, parentRelative, currentName, newName }) => {
  if (typeof currentName !== 'string' || !currentName) {
    throw new ValidationError('Original name is required.');
  }

  const {
    allowed: parentAllowed,
    accessInfo: parentAccess,
    resolved: parentResolved,
  } = await authorizeAndResolve(context, parentRelative, ACTIONS.write);
  if (!parentAllowed || !parentResolved) {
    throw new ForbiddenError(parentAccess?.denialReason || 'Destination path is read-only.');
  }

  const currentRelative = combineRelativePath(parentRelative, currentName);
  const {
    allowed: currentAllowed,
    accessInfo: currentAccess,
    resolved: currentResolved,
  } = await authorizeAndResolve(context, currentRelative, ACTIONS.write);
  if (!currentAllowed || !currentResolved) {
    throw new ForbiddenError(currentAccess?.denialReason || 'Cannot rename items in this path.');
  }

  const currentAbsolute = currentResolved.absolutePath;
  if (!(await pathExists(currentAbsolute))) {
    throw new NotFoundError('Item not found.');
  }

  if (typeof newName !== 'string' || !newName) {
    throw new ValidationError('A new name is required.');
  }

  let validatedNewName;
  try {
    validatedNewName = ensureValidName(newName);
  } catch (error) {
    // ensureValidName throws a plain Error, which the error handler could only
    // read as a server fault. A name with a path separator in it is the
    // caller's, and answering 500 to it sent everyone looking in the wrong
    // place — including the logs, where it appeared as an unhandled failure.
    throw new ValidationError(error.message);
  }

  // Renaming a file to what it is already called is a no-op, not a conflict.
  if (validatedNewName === currentName) {
    return {
      absolutePath: currentAbsolute,
      relativePath: currentRelative,
      name: currentName,
      previousAbsolutePath: currentAbsolute,
      changed: false,
    };
  }

  const targetRelative = combineRelativePath(parentRelative, validatedNewName);
  const { allowed: targetAllowed, accessInfo: targetAccess } = await authorizePath(
    context,
    targetRelative,
    ACTIONS.write
  );
  if (!targetAllowed) {
    throw new ForbiddenError(targetAccess?.denialReason || 'Destination path is not accessible.');
  }

  const targetAbsolute = path.join(parentResolved.absolutePath, validatedNewName);
  if (await pathExists(targetAbsolute)) {
    throw new ConflictError(`The name "${validatedNewName}" is already taken.`);
  }

  await fs.rename(currentAbsolute, targetAbsolute);
  // Same-parent rename: no size delta, but re-key an indexed directory subtree.
  folderSizeHooks.onEntryRenamed(currentAbsolute, targetAbsolute);

  return {
    absolutePath: targetAbsolute,
    relativePath: targetRelative,
    name: validatedNewName,
    previousAbsolutePath: currentAbsolute,
    changed: true,
  };
};

module.exports = { renameEntry };
