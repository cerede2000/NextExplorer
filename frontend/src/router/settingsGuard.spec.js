import { describe, expect, it, vi } from 'vitest';
import { loadAccountSettings } from './settingsGuard';

/**
 * The settings a signed-in account's pages read, asked for by the guard.
 *
 * Whether the router calls this on the share path is held by the browser test
 * that opens a document from inside a share with "open in a tab" chosen — the
 * failure this exists for, and one that only shows on the real build.
 */

const stores = (isAuthenticated, ensureLoaded = vi.fn(async () => {})) => ({
  auth: { isAuthenticated },
  appSettings: { ensureLoaded },
});

describe('the settings of the account that is signed in', () => {
  it('are loaded before the page that reads them', async () => {
    const signedIn = stores(true);
    await loadAccountSettings(signedIn);
    expect(signedIn.appSettings.ensureLoaded).toHaveBeenCalledTimes(1);
  });

  // A visitor holding only a link has no settings of their own, and the
  // branding everybody sees is loaded at start.
  it('are not asked for on behalf of nobody', async () => {
    const visitor = stores(false);
    await loadAccountSettings(visitor);
    expect(visitor.appSettings.ensureLoaded).not.toHaveBeenCalled();
  });

  it('do not stop the navigation when they cannot be read', async () => {
    const failing = stores(
      true,
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    await expect(loadAccountSettings(failing)).resolves.toBeUndefined();
  });

  /**
   * Nor when they are never read at all.
   *
   * This is awaited inside a navigation guard, so a request that never settles
   * is not a slow page — it is a guard that never returns, and a guard that
   * never returns is a screen that never changes: no error, no spinner, nothing
   * to press. A visitor who followed a share link meets exactly that, because
   * an authentication proxy answers the calls it will not pass with a redirect
   * somewhere else, and nothing in the HTTP layer here carries a deadline.
   *
   * A preference is not a permission: the page is drawn either way.
   */
  it('do not stop it when they never arrive at all', async () => {
    const neverSettles = stores(
      true,
      vi.fn(() => new Promise(() => {}))
    );

    await expect(loadAccountSettings(neverSettles, { timeoutMs: 5 })).resolves.toBeUndefined();
    expect(neverSettles.appSettings.ensureLoaded).toHaveBeenCalledTimes(1);
  });

  // And a bound is not a reason to stop waiting for an answer that is coming:
  // the settings that arrive in time are still the ones the page is drawn with.
  it('still wait for the ones that answer', async () => {
    const slow = stores(
      true,
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { thumbnails: true };
      })
    );

    await loadAccountSettings(slow, { timeoutMs: 1000 });

    expect(slow.appSettings.ensureLoaded).toHaveBeenCalledTimes(1);
  });
});
