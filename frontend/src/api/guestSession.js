import { ref } from 'vue';

/**
 * The share session this tab is carrying, as a value that can be watched.
 *
 * It lives in `sessionStorage` because it belongs to one tab and must survive a
 * reload: a visitor who typed a share's password is not asked again when the
 * page comes back. What it cannot be is *read* from there on demand.
 *
 * It used to be, and the screen a visitor got depended on when something first
 * looked. `isGuest` was a computed around `sessionStorage.getItem(...)`, and its
 * one reactive value sat behind a `&&` that short-circuited whenever the session
 * was absent — so a reader arriving before the session existed pinned `false`
 * with no dependency to ever invalidate it. Behind an authentication proxy that
 * is exactly what happened: the first refused call woke the session-expiry
 * handler, which asked, and from then on the application believed a visitor with
 * no account was a signed-in one. It drew them the sidebar of an account and
 * asked the server for their favourites and their volumes — two refusals handed
 * to somebody who can do nothing about either.
 *
 * So the session is a ref, written where it is stored, and `sessionStorage` is
 * where it is kept rather than where it is consulted.
 */

const ID_KEY = 'guestSessionId';
const TOKEN_KEY = 'guestSessionShareToken';

/**
 * Storage a browser can refuse: a private window with site data blocked throws
 * on the first read. A visitor who cannot keep a session is simply never a
 * guest, which is the same answer as not having one.
 */
const read = (key) => {
  try {
    return sessionStorage.getItem(key);
  } catch (_) {
    return null;
  }
};

const write = (key, value) => {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch (_) {
    /* nothing kept, nothing lost */
  }
};

export const guestSessionId = ref(read(ID_KEY));
export const guestSessionShareToken = ref(read(TOKEN_KEY));

/** The session a share just handed out, kept for this tab. */
export const rememberGuestSession = (sessionId, shareToken = '') => {
  write(ID_KEY, sessionId);
  guestSessionId.value = sessionId || null;
  if (sessionId && shareToken) {
    write(TOKEN_KEY, shareToken);
    guestSessionShareToken.value = shareToken;
  }
};

/** No longer a guest: signed in, signed out, or sent away by the server. */
export const forgetGuestSession = () => {
  write(ID_KEY, null);
  write(TOKEN_KEY, null);
  guestSessionId.value = null;
  guestSessionShareToken.value = null;
};
