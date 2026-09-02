/**
 * Where the home page goes when there is nothing to choose on it.
 *
 * On a single-volume setup the dashboard is a page with one thing on it, and
 * `SKIP_HOME` — or the same preference set by the person themselves — sends
 * them straight into it instead.
 *
 * Everything here fails softly on purpose. A feature flag that will not load, a
 * volume list that will not answer: neither is a reason to refuse a navigation
 * to the home page, which is the one place a visitor can always get to. So each
 * step falls back to showing the dashboard rather than to an error.
 *
 * @returns {Promise<object|null>} the volume to go to instead, or null to show
 *   the home page
 */
export const skipHomeDestination = async ({ appSettings, featuresStore, getVolumes }) => {
  try {
    await featuresStore.ensureLoaded();
  } catch (_) {
    // A flag that cannot be read is a flag that is not set.
  }

  // The person's own preference wins over the deployment's default, and only
  // an unset preference falls through to it — `false` is an answer.
  const preference = appSettings.userSettings?.skipHome;
  const skip =
    preference !== null && preference !== undefined ? preference : featuresStore.skipHome;
  if (!skip) return null;

  try {
    const volumes = await getVolumes();
    const first = Array.isArray(volumes) ? volumes[0] : null;
    if (first?.path) return { name: 'FolderView', params: { path: first.path } };
  } catch (_) {
    // No volumes to jump into is the same as nowhere to jump.
  }

  return null;
};
