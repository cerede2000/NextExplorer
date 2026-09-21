/**
 * The signed-in account's settings, loaded before the page that reads them.
 *
 * Every page reached while signed in reads them: whether thumbnails show, how
 * a folder is sorted, whether a document opens in a tab of its own. A page
 * reached through a share goes through the share check instead of the rest of
 * the guard, and was served only because the uploader happened to load the
 * settings on mounting — when Uppy stopped loading with the page, a document
 * inside a share opened in place for somebody who had asked for a tab. The
 * guard asks for them itself now, in both places.
 *
 * A visitor without an account has none to load; the branding everybody sees
 * is loaded at start (`main.js`).
 *
 * @param {{ auth: { isAuthenticated: boolean }, appSettings: { ensureLoaded: () => Promise<unknown> } }} stores
 */
export const loadAccountSettings = async ({ auth, appSettings }) => {
  if (!auth?.isAuthenticated) return;
  try {
    await appSettings.ensureLoaded();
  } catch (_) {
    // Non-fatal; the UI will behave conservatively if settings aren't available.
  }
};
