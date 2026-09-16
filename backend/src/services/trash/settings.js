/**
 * The trash settings in force, read from the system settings every time.
 *
 * Not cached here: an administrator who switches the trash off expects the next
 * deletion to see it, and the settings service already memoizes per request.
 */
const getTrashSettings = async () => {
  // Required lazily: the settings service is a large module that most of the
  // trash has no other reason to load.
  const { getSystemSettings } = require('../settingsService');
  return (await getSystemSettings()).trash;
};

module.exports = { getTrashSettings };
