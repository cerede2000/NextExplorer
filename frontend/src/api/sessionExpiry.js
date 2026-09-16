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
 * @returns {(errorInfo?: object) => 'expired'|'quiet'|false} what this 401 was.
 *   `'expired'` is a session that ended: the request is answered by taking the
 *   person to the login screen, and its error says so. `'quiet'` is a 401 on
 *   the login screen itself — an answer to what somebody typed — which raises
 *   no toast and is otherwise an ordinary refusal, message and code and all.
 *   `false` is nothing to do with this handler.
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

    // Already on the way. Every request in flight arrives here within the same
    // tick, and only the first has anything to do — but all of them are the
    // same expiry, or the toasts come back.
    if (navigating) return 'expired';

    /**
     * The login screen itself.
     *
     * A 401 here is an answer to what somebody just typed — a wrong password,
     * a wrong second-factor code — and not a session that ended: there is
     * nowhere to send them and nothing to announce, because the screen says it
     * itself, under the field. Calling it an expiry is what replaced those
     * refusals with an error of our own making, carrying the server's English
     * sentence onto a screen in somebody else's language.
     *
     * A request that was already in flight when the redirect landed here ends
     * up in the same place, and is as quiet as it was before.
     */
    if (current?.meta?.authScreen) return 'quiet';

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

    return 'expired';
  };
};
