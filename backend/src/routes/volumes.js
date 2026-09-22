const express = require('express');
const fs = require('fs/promises');

const { directories, excludedFiles, features, hiddenFiles } = require('../config/index');
const path = require('path');

const asyncHandler = require('../utils/asyncHandler');
const { getVolumesForUser } = require('../services/userVolumesService');
const { getAccessInfo } = require('../services/accessManager');
const { whyNotWritable } = require('../services/storageWritability');

const router = express.Router();

/**
 * Why nothing can be written in a volume, for the mark beside its name on the
 * home page and in the sidebar — or null when something can.
 *
 * The storage first, because it holds for everyone: `storage` for a read-only
 * mount, `permission` for a folder the server may not write in. Then the
 * account: `access` when a rule or the volume's assignment makes it read-only
 * for whoever is asking. A volume bound `:ro` looked like any other until
 * something was attempted in it (nxzai/NextExplorer#407).
 */
const readOnlyReason = async (context, logicalPath, absolutePath) => {
  const storage = await whyNotWritable(absolutePath);
  if (storage) return storage;
  try {
    const access = await getAccessInfo(context, logicalPath);
    return access?.canAccess && !access.canWrite ? 'access' : null;
  } catch {
    return null;
  }
};

const withReadOnly = (context, volumes, absoluteOf) =>
  Promise.all(
    volumes.map(async (volume) => ({
      ...volume,
      readOnly: await readOnlyReason(context, volume.path, absoluteOf(volume)),
    }))
  );

/**
 * Get all volumes from VOLUME_ROOT (admin view or when USER_VOLUMES is disabled)
 */
const getAllVolumes = async () => {
  const entries = await fs.readdir(directories.volume, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !excludedFiles.includes(name))
    .filter((name) => !hiddenFiles.isHiddenName(name))
    .map((name) => ({
      name,
      path: name,
      kind: 'volume',
    }));
};

router.get(
  '/volumes',
  asyncHandler(async (req, res) => {
    const user = req.user;
    const isAdmin = user?.roles?.includes('admin');
    const userVolumesEnabled = features.userVolumes;

    // A share visitor has no business listing the volumes: they reach files
    // through their share token only. Without this the next branch would run
    // for them too, since USER_VOLUMES is off by default.
    if (!user || !user.id) {
      return res.json([]);
    }

    // If USER_VOLUMES is disabled or user is admin, show all volumes from VOLUME_ROOT
    const context = { user, guestSession: req.guestSession };

    if (!userVolumesEnabled || isAdmin) {
      const volumeData = await getAllVolumes();
      return res.json(
        await withReadOnly(context, volumeData, (volume) =>
          path.join(directories.volume, volume.name)
        )
      );
    }

    // For regular users when USER_VOLUMES is enabled, show only assigned volumes
    const userVolumes = await getVolumesForUser(user.id);

    const volumeData = userVolumes.map((vol) => ({
      name: vol.label,
      path: vol.label, // Use label as the path identifier for navigation
      kind: 'volume',
      accessMode: vol.accessMode,
      actualPath: vol.path, // Include actual path for reference
    }));

    res.json(await withReadOnly(context, volumeData, (volume) => volume.actualPath));
  })
);

module.exports = router;
