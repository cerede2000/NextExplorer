import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionExpiryHandler } from './sessionExpiry';

/**
 * A session that ends while somebody is using the application.
 *
 * The navigation guard already sends a visitor without a session to the login
 * screen, and that covered arriving without one. It does not cover running out
 * of one: a guard only runs on navigation, and nobody navigates while reading a
 * folder. So the screen stayed as it was, every request behind it began failing
 * 401, and the account of it was a row of error toasts — including, on an OIDC
 * installation, our own "Network Error" whose details point at PUBLIC_URL and
 * CORS. Nothing was wrong with the deployment. The session had ended.
 */

let router;
let auth;

const routeAt = (fullPath, meta = {}) => ({ value: { fullPath, meta } });

beforeEach(() => {
  router = {
    currentRoute: routeAt('/browse/Documents'),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  auth = {
    isAuthenticated: true,
    isGuest: false,
    forgetSession: vi.fn(() => {
      auth.isAuthenticated = false;
    }),
  };
});

const handler = () => createSessionExpiryHandler({ router, auth });

describe('a session that runs out mid-use', () => {
  it('takes the person to the login screen', async () => {
    handler()();

    expect(router.replace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'auth-login' })
    );
  });

  it('says why the login screen is showing', async () => {
    handler()();

    expect(router.replace.mock.calls[0][0].query.reason).toBe('expired');
  });

  /** Signing in again should return to the folder that was open, not to the root. */
  it('remembers where they were', async () => {
    handler()();

    expect(router.replace.mock.calls[0][0].query.redirect).toBe('/browse/Documents');
  });

  it('drops the session locally rather than asking a dead session to end itself', () => {
    handler()();

    expect(auth.forgetSession).toHaveBeenCalled();
  });

  /**
   * Nothing calls the logout endpoint: the session is already gone, so that
   * request would be answered 401 too — or, with an identity provider, with a
   * redirect a fetch cannot follow, which is where the CORS message came from.
   */
  it('reports that it has taken the request in hand', () => {
    expect(handler()()).toBe(true);
  });
});

describe('the burst of requests behind it', () => {
  /**
   * One expired session fails everything in flight, and they all arrive within
   * the same tick. Only the first has anything to do.
   */
  it('navigates once however many requests fail', () => {
    const onExpiry = handler();

    onExpiry();
    onExpiry();
    onExpiry();

    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  /** But every one of them is handled, or the toasts come back. */
  it('still answers for the later ones', () => {
    const onExpiry = handler();

    onExpiry();

    expect(onExpiry()).toBe(true);
    expect(onExpiry()).toBe(true);
  });

  it('does nothing more once the login screen is showing', () => {
    router.currentRoute = routeAt('/auth/login', { authScreen: true });
    auth.isAuthenticated = false;

    expect(handler()()).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('who this is not for', () => {
  /**
   * A guest holds a share link and has no account to sign back in to. A login
   * form would answer a question they never asked.
   */
  it('leaves a guest to the ordinary error path', () => {
    auth.isGuest = true;
    auth.isAuthenticated = false;

    expect(handler()()).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  });

  /**
   * With authentication disabled the store reports every visitor as
   * authenticated, guests included. An installation with no accounts must not
   * be shown a login screen, so the guest question is asked first — and asked
   * of a shape where the session question would answer the wrong way.
   */
  it('leaves a guest alone even where every visitor counts as authenticated', () => {
    auth.isGuest = true;
    auth.isAuthenticated = true;

    expect(handler()()).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  });

  /**
   * A request that ran before the guard could redirect never had a session to
   * lose, and the guard is the right thing to answer it.
   */
  it('leaves a visitor who never signed in to the guard', () => {
    auth.isAuthenticated = false;

    expect(handler()()).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('where it comes back to', () => {
  it('does not offer an auth screen as the destination', () => {
    router.currentRoute = routeAt('/auth/login');

    handler()();

    expect(router.replace.mock.calls[0][0].query.redirect).toBe('/browse/');
  });

  it('falls back when there is no current route to speak of', () => {
    router.currentRoute = { value: null };

    handler()();

    expect(router.replace.mock.calls[0][0].query.redirect).toBe('/browse/');
  });

  /** A failed navigation must not wedge it: the next expiry has to work. */
  it('recovers when the navigation itself fails', async () => {
    router.replace = vi.fn().mockRejectedValue(new Error('navigation aborted'));
    const onExpiry = handler();

    onExpiry();
    await Promise.resolve();
    await Promise.resolve();
    auth.isAuthenticated = true;
    onExpiry();

    expect(router.replace).toHaveBeenCalledTimes(2);
  });
});
