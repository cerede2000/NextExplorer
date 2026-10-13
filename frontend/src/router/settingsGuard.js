/**
 * How long a page may wait for them.
 *
 * A parameter rather than a constant so a test can use a millisecond instead of
 * two seconds, and so the number has a name where its reason is written.
 */
const SETTLE_WITHIN_MS = 2000;

/** Resolves after `ms`, so a wait can be bounded without rejecting. */
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * **Bounded, because this is awaited inside a navigation guard.** A preference
 * is not a permission: a request that never settles would hold the guard open
 * for ever, and a navigation guard that never returns is a page that never
 * changes — no error, no spinner, nothing to press. That shape is reachable.
 * An HTTP call here carries no deadline of its own, and an authentication proxy
 * in front of this application answers a request it will not pass with a
 * redirect to somewhere else entirely; a share's visitor is exactly who meets
 * one, on a page whose only way forward is this guard returning. So the wait
 * ends either way, and the page is drawn with whatever the settings were.
 *
 * @param {{ auth: { isAuthenticated: boolean }, appSettings: { ensureLoaded: () => Promise<unknown> } }} stores
 * @param {{ timeoutMs?: number }} [options]
 */
export const loadAccountSettings = async ({ auth, appSettings }, { timeoutMs } = {}) => {
  if (!auth?.isAuthenticated) return;
  try {
    await Promise.race([appSettings.ensureLoaded(), after(timeoutMs ?? SETTLE_WITHIN_MS)]);
  } catch (_) {
    // Non-fatal; the UI will behave conservatively if settings aren't available.
  }
};
