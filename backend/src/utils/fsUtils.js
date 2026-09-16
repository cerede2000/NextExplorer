const fs = require('fs/promises');

const ensureDir = async (targetPath) => {
  await fs.mkdir(targetPath, { recursive: true });
};

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
