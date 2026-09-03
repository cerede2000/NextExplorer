/**
 * What happens when a session ends while somebody is using the application.
 *
 * The navigation guard already sends a visitor without a session to the login
 * screen — but it only runs on navigation, and a session expires while nobody
 * is navigating. So the screen stayed exactly as it was, every request behind
 * it started failing, and the only account of it was a row of error toasts. On
 * an OIDC installation those included our own "Network Error", whose details
 * suggest looking at PUBLIC_URL and CORS: an accurate description of a fetch
 * that got nowhere, and a thoroughly misleading explanation of why.
 *
 * Nothing was actually wrong with the deployment. The session had ended, which
 * is a normal thing for a session to do, and the interface had no way to say so.
 */

/**
 * @param {object} deps
 * @param {import('vue-router').Router} deps.router
 * @param {object} deps.auth the auth store
 * @returns {(errorInfo?: object) => boolean} true when it has taken the request
 *   in hand, which suppresses the per-request error toast
 */
export const createSessionExpiryHandler = ({ router, auth }) => {
  let navigating = false;

  return () => {
    // A guest holds a share link and has no account to sign back in to. Sending
    // them to a login form would be an answer to a question they never asked,
    // so their 401 is left to the ordinary error path.
    //
    // Checked before the session below rather than folded into it: with
    // authentication disabled the store reports every visitor as authenticated,
    // guests included, and a login screen is the last thing an installation
    // with no accounts should offer. Nothing 401s in that mode today, which is
    // an assumption about the server holding a few layers away — cheaper to
    // not depend on it.
    if (auth.isGuest) return false;

    const current = router.currentRoute?.value;

    // Already on the way, or already there. Every request in flight arrives
    // here within the same tick, and only the first has anything to do — but
    // all of them are handled, or the toasts come back.
    if (navigating || Boolean(current?.meta?.authScreen)) return true;

    // Never had a session to lose: this is a request that ran before the guard
    // could redirect, and the guard is the right thing to answer it.
    if (!auth.isAuthenticated) return false;

    navigating = true;
    auth.forgetSession();

    /**
     * Where to come back to, so signing in again returns to the page that was
     * open rather than to the root.
     */
    const redirect =
      typeof current?.fullPath === 'string' && !current.fullPath.startsWith('/auth/')
        ? current.fullPath
        : '/browse/';

    // `replace`, not `push`: the page whose session has expired is not
    // somewhere the back button should return to.
    Promise.resolve(router.replace({ name: 'auth-login', query: { redirect, reason: 'expired' } }))
      .catch(() => {
        // A navigation the router abandons is not this handler's failure: a
        // guard may send the visitor somewhere else, or another navigation may
        // already have started. What matters is that the flag below is cleared
        // so the next expiry still works.
        //
        // `finally` alone does not do it. It passes a rejection straight
        // through, so the promise ended rejected with nobody listening — an
        // unhandled rejection in the console of anyone whose session expired
        // mid-navigation, and a failed test run for a suite that treats one as
        // an error.
      })
      .finally(() => {
        navigating = false;
      });

    return true;
  };
};
