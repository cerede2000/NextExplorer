/**
 * The file version settings in force, read from the system settings every time.
 *
 * Not cached, for the trash's reason: an administrator who switches versions off
 * expects the next save to see it.
 */
const getVersionSettings = async () => {
  const { getSystemSettings } = require('../settingsService');
  return (await getSystemSettings()).versions;
};

module.exports = { getVersionSettings };
