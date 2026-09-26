const express = require('express');
const fs = require('fs/promises');

const { directories, excludedFiles, features, hiddenFiles } = require('../config/index');
const asyncHandler = require('../utils/asyncHandler');
const { getVolumesForUser } = require('../services/userVolumesService');
const { getAccessInfo } = require('../services/accessManager');

const router = express.Router();

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

/**
 * Drop the ones this caller may not reach.
 *
 * A `hidden` rule on a volume kept it out of the folder listing and refused it
 * by its address, and left its name in the sidebar and on the home page for
 * everybody — which is the one place a hidden folder is most visible. This is
 * the same question the listing asks, asked of the volumes.
 */
const visibleTo = async (context, volumes) => {
  const answers = await Promise.all(
    volumes.map(async (volume) => {
      try {
        return (await getAccessInfo(context, volume.path))?.canAccess === true;
      } catch {
        // A volume nothing can answer for stays listed: opening it is refused
        // on its own, and a sidebar that empties itself on a transient failure
        // is worse than one naming a folder that turns out to be closed.
        return true;
      }
    })
  );
  return volumes.filter((_volume, index) => answers[index]);
};

router.get(
  '/volumes',
  asyncHandler(async (req, res) => {
    const user = req.user;
    const isAdmin = user?.roles?.includes('admin');
    const userVolumesEnabled = features.userVolumes;
    const context = { user, guestSession: req.guestSession };

    // If USER_VOLUMES is disabled or user is admin, show all volumes from VOLUME_ROOT
    if (!userVolumesEnabled || isAdmin) {
      return res.json(await visibleTo(context, await getAllVolumes()));
    }

    // For regular users when USER_VOLUMES is enabled, show only assigned volumes
    if (!user || !user.id) {
      return res.json([]);
    }

    const userVolumes = await getVolumesForUser(user.id);

    const volumeData = userVolumes.map((vol) => ({
      name: vol.label,
      path: vol.label, // Use label as the path identifier for navigation
      kind: 'volume',
      accessMode: vol.accessMode,
      actualPath: vol.path, // Include actual path for reference
    }));

    res.json(await visibleTo(context, volumeData));
  })
);

module.exports = router;
