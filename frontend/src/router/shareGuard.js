import { getShareInfo } from '@/api/shares.api';
import { getGuestSessionShareToken } from '@/api';

/**
 * Who may open a share link, decided before the view loads.
 *
 * This lives apart from the router so it can be tested on its own: importing
 * the router pulls in every view, and a rule this easy to get wrong — it
 * decides whether a visitor sees files or a password prompt — should not be
 * verifiable only by hand.
 */

/**
 * The guard runs on every folder change inside a share, and the answer for a
 * given token does not change while the tab is open. Without this cache each
 * click paid a serialized round-trip before the folder even started loading.
 *
 * The viewer is part of the key: the owner skips the prompt, so signing in as
 * someone else has to ask again.
 */
const shareInfoCache = new Map();

const cacheKey = (shareToken, viewerId) => `${viewerId || 'anonymous'}:${shareToken}`;

const getCachedShareInfo = (shareToken, viewerId) => {
  const key = cacheKey(shareToken, viewerId);
  if (!shareInfoCache.has(key)) {
    shareInfoCache.set(
      key,
      getShareInfo(shareToken).catch((error) => {
        // Do not cache a failure: the next navigation should retry.
        shareInfoCache.delete(key);
        throw error;
      })
    );
  }
  return shareInfoCache.get(key);
};

export const resetShareInfoCache = () => shareInfoCache.clear();

/**
 * Read the guest session the visitor is carrying.
 *
 * Call this BEFORE auth.initialize(): that call clears guestSessionId as soon
 * as it sees a signed-in user, so reading afterwards would lose the proof that
 * a signed-in visitor already typed the password of a protected link — and
 * send them back to the prompt on every reload.
 */
export const readGuestSession = () => ({
  id: sessionStorage.getItem('guestSessionId'),
  shareToken: getGuestSessionShareToken(),
});

/**
 * @param {object} params
 * @param {{id: string|null, shareToken: string|null}} params.guestSession read
 *   before auth.initialize() ran.
 * @returns {Promise<true | {name: string, params: object, query: object}>}
 * true to let the navigation through, or the route to redirect to.
 */
export const resolveShareAccess = async ({ shareToken, fullPath, auth, guestSession }) => {
  const carried = guestSession || readGuestSession();

  // A verified guest session is always enough.
  if (carried.id && carried.shareToken === shareToken) {
    return true;
  }

  // Being signed in is enough too, unless the link is password-protected: the
  // backend asks every non-owner for it, so send them to the prompt rather
  // than into a view that will only get refusals. requiresPassword already
  // accounts for who is asking, so the owner is not sent to a prompt for
  // their own share.
  if (auth.isAuthenticated) {
    try {
      const info = await getCachedShareInfo(shareToken, auth.currentUser?.id);
      if (!info?.requiresPassword) return true;
    } catch {
      // Unreachable or unknown share: let the view surface the error.
      return true;
    }
  }

  return {
    name: 'ShareLogin',
    params: { token: shareToken },
    query: { redirect: fullPath },
  };
};
