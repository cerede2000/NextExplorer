/**
 * What a browser has to remember across a trip to the identity provider.
 *
 * Handing a sign-in to a provider is a navigation away from the application:
 * everything the sign-in screen knew is gone by the time the browser comes
 * back, and what greets it is a brand-new screen with no memory of having sent
 * anybody anywhere. These two marks are what that screen reads to tell the
 * endings apart — came back from a sign-out, came back from a hand-off with
 * nothing to show for it — and each is consumed the first time it is read,
 * because each describes one trip and not the state of the tab.
 *
 * Read-and-remove is the whole point. The sign-out mark used to be cleared
 * only by the single sign-on button, so anybody who signed out and then signed
 * in some other way left it behind for the rest of the tab's life: the next
 * session to run out in that tab stopped at a button instead of going to the
 * provider, and pressing it made the provider ask for a password that was not
 * needed.
 *
 * `sessionStorage` rather than anything shared: the trip belongs to one tab,
 * and a second tab must not be told about a journey it never made. Every
 * access is guarded — a browser in private mode throws rather than answering.
 */

const SIGNED_OUT = 'oidcSignedOut';
const HANDED_OFF = 'oidcHandoff';

/**
 * How long a hand-off that came back with nothing counts as the reason this
 * screen is here.
 *
 * A round trip through a provider takes seconds. An hour later the same mark
 * says nothing about the session that has just run out, so it is ignored
 * rather than used to refuse a hand-off that would have worked.
 */
const HANDOFF_WINDOW_MS = 2 * 60 * 1000;

const store = () => {
  try {
    return window.sessionStorage || null;
  } catch (_) {
    return null;
  }
};

const write = (key, value) => {
  try {
    store()?.setItem(key, value);
  } catch (_) {
    // A browser that refuses to remember costs a stop at the button instead of
    // an automatic hand-off, which is a worse screen and not a broken one.
  }
};

const take = (key) => {
  const held = store();
  if (!held) return null;
  try {
    const value = held.getItem(key);
    held.removeItem(key);
    return value;
  } catch (_) {
    return null;
  }
};

/** Somebody signed out of a provider-backed account, in this tab. */
export const markSignedOut = () => write(SIGNED_OUT, '1');

/** And the screen that reads it, once. */
export const takeSignedOut = () => take(SIGNED_OUT) === '1';

/** A sign-in is being handed to the provider now. */
export const markHandedOff = () => write(HANDED_OFF, String(Date.now()));

/**
 * Whether this screen is here because a hand-off came back without a session.
 *
 * The one thing that stops an endless round trip: the provider signs somebody
 * in, this application ends up with no session for them anyway — no account
 * here, a cookie the browser would not keep, an identity it will not create —
 * and the sign-in screen hands them straight back to the provider, which
 * signs them in again. Nothing in that circle ever reaches a person, and the
 * only account of it is a logo spinning for as long as they are willing to
 * watch it.
 *
 * Consumed whether it is acted on or not: a mark left behind would refuse the
 * next hand-off too.
 */
export const takeHandedOffRecently = (now = Date.now()) => {
  const at = Number(take(HANDED_OFF));
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at < HANDOFF_WINDOW_MS;
};

/** A session was obtained, so no trip is outstanding. */
export const forgetHandedOff = () => {
  take(HANDED_OFF);
};
