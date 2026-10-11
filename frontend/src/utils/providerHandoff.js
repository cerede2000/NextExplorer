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
 * What tells a circle from somebody trying again.
 *
 * One hand-off that came back without a session says almost nothing. Somebody
 * who walked away from the provider's page and then opened this address again
 * has done exactly that, and what they want is to be sent to the provider —
 * which is what they came here for. Reading their *one* unfinished trip as a
 * circle stopped them at a wall they had done nothing to deserve.
 *
 * A circle is not one trip, it is *repetition*: the provider signs somebody in,
 * this application has no session for them anyway, the screen sends them back,
 * and the whole lap takes well under a second because nobody is typing
 * anything. So what is counted is laps within a few seconds — three of them is
 * a machine, and no hand is fast enough to leave for a provider and come back
 * three times in ten.
 */
const HANDOFF_WINDOW_MS = 10 * 1000;
const HANDOFFS_THAT_MAKE_A_CIRCLE = 3;

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

/** The laps still inside the window, oldest first. */
const lapsHeld = (now) => {
  const held = store();
  if (!held) return [];
  let raw;
  try {
    raw = held.getItem(HANDED_OFF);
  } catch (_) {
    return [];
  }
  let times;
  try {
    times = JSON.parse(raw || '[]');
  } catch (_) {
    // Including the single timestamp earlier versions wrote here.
    times = [];
  }
  if (!Array.isArray(times)) return [];
  return times.filter((at) => Number.isFinite(at) && now - at < HANDOFF_WINDOW_MS).slice(-10);
};

/** A sign-in is being handed to the provider now. */
export const markHandedOff = (now = Date.now()) => {
  write(HANDED_OFF, JSON.stringify([...lapsHeld(now), now]));
};

/**
 * Whether this screen is going round in a circle.
 *
 * The one thing that stops an endless round trip: the provider signs somebody
 * in, this application ends up with no session for them anyway — no account
 * here, a cookie the browser would not keep, an identity it will not create —
 * and the sign-in screen hands them straight back to the provider, which
 * signs them in again. Nothing in that circle ever reaches a person, and the
 * only account of it is a logo spinning for as long as they are willing to
 * watch it.
 *
 * Asked without consuming anything: the laps are what the next hand-off counts
 * from, and they fall out of the window on their own. A session obtained is
 * what clears them, because that is what ends the circle.
 */
export const goingInCircles = (now = Date.now()) =>
  lapsHeld(now).length >= HANDOFFS_THAT_MAKE_A_CIRCLE;

/** A session was obtained, so there is no circle to be in. */
export const forgetHandedOff = () => {
  take(HANDED_OFF);
};
