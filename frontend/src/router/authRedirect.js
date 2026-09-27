/**
 * Where a navigation has to go instead, when it is a question of who is signed
 * in.
 *
 * Pulled out of the navigation guard as a function of its two inputs and
 * nothing else, because this is the part that locks people out when it is
 * wrong: a redirect loop between the login screen and the page behind it is
 * invisible in a test that checks one hop, and it is the whole application
 * from the outside.
 *
 * The order of the questions is the order the guard asked them in, kept
 * deliberately. Asking about the setup screen before asking whether anybody is
 * signed in changes which path a visitor is sent back to afterwards, for a
 * route named `auth-setup` that is not flagged as an auth screen — a
 * combination this application never builds, and not one worth leaving a
 * difference over.
 *
 * @param {object} to the route being navigated to
 * @param {object} auth the auth store: `requiresSetup`, `isAuthenticated`
 * @returns {object|null} a route to go to instead, or null to carry on
 */
export const authRedirect = (to, auth) => {
  const isAuthScreen = Boolean(to.meta?.authScreen);

  /**
   * Where to come back to once the visitor is through.
   *
   * Never an auth screen: remembering `/auth/login` as the destination is how a
   * successful sign-in lands back on the login form.
   */
  const comeBackTo = (fallback = '/browse/') => {
    const candidate = typeof to.fullPath === 'string' ? to.fullPath : fallback;
    return !candidate || candidate.startsWith('/auth/') ? fallback : candidate;
  };

  const requestedRedirect = () =>
    typeof to.query?.redirect === 'string' ? to.query.redirect : '/browse/';

  // Nobody has an account yet: the only thing to do is make one.
  if (auth.requiresSetup) {
    if (!isAuthScreen || to.name !== 'auth-setup') {
      return { name: 'auth-setup', query: { redirect: comeBackTo() } };
    }
  } else if (!auth.isAuthenticated && !isAuthScreen) {
    return { name: 'auth-login', query: { redirect: comeBackTo() } };
  }

  // Setup is done, so the setup screen is a page that no longer exists.
  if (to.name === 'auth-setup' && !auth.requiresSetup) {
    const redirect = requestedRedirect();
    return auth.isAuthenticated ? { path: redirect } : { name: 'auth-login', query: { redirect } };
  }

  // Signed in already: the login screen has nothing left to ask.
  if (to.name === 'auth-login' && auth.isAuthenticated) {
    return { path: requestedRedirect() };
  }

  return null;
};
