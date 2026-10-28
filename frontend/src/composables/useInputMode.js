import { computed, ref } from 'vue';

/**
 * Which pointer the reader is using, rather than which the machine owns.
 *
 * This decides how a row answers a click: with a finger, one tap opens and
 * selecting is a mode you turn on; with a pointer, one click selects and two
 * open. Getting it wrong does not break anything, it just makes every click
 * mean the other thing.
 *
 * It used to ask three questions and take any `yes`: `navigator.maxTouchPoints
 * > 0`, `(pointer: coarse)`, and `'ontouchstart' in window`. Two of those
 * describe what the machine *can* do, not what is being done with it, and the
 * first is the worst of them — on Windows it reports what the system believes
 * it has, which on one ThinkBook with no digitizer at all (`SM_DIGITIZER` and
 * `SM_MAXIMUMTOUCHES` both zero) still reached the page as sixteen, while the
 * same page said the primary pointer was fine and that touch events did not
 * exist. Something between the two rewrites it, and a privacy extension that
 * blurs a fingerprint is a likely candidate — which is the point: a value
 * nobody can vouch for should not decide how the reader's clicks are read.
 *
 * So: start from the one question that is about use rather than capability —
 * whether the *primary* pointer is coarse, which a phone answers yes and a
 * laptop with a touchscreen and a mouse answers no — and then let the reader
 * settle it by touching something. A finger says touch, a mouse or a pen says
 * pointer, and the application follows whichever came last.
 *
 * One piece of state for the whole application rather than one per caller:
 * every row, the toolbar and the drag handling have to agree, and a computed
 * per component that reads nothing reactive is also a computed that is worked
 * out once and then never again — so the old one could not have followed
 * anything even if it had wanted to.
 */

const COARSE_POINTER = '(pointer: coarse)';

const primaryPointerIsCoarse = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return Boolean(window.matchMedia(COARSE_POINTER).matches);
  } catch (_) {
    return false;
  }
};

const usingTouch = ref(primaryPointerIsCoarse());

let following = false;

const followTheReader = () => {
  if (following || typeof window === 'undefined') return;
  following = true;

  // Capturing and passive: this only watches. It must not be stopped by a
  // handler that calls `stopPropagation`, and it must never delay a tap.
  window.addEventListener(
    'pointerdown',
    (event) => {
      const kind = event?.pointerType;
      if (kind === 'touch') usingTouch.value = true;
      // A pen is a precise pointer: it can hit a checkbox, so it is read as
      // one. An unknown kind says nothing and is left alone.
      else if (kind === 'mouse' || kind === 'pen') usingTouch.value = false;
    },
    { capture: true, passive: true }
  );

  // And the ground can move under a session: a tablet put into a dock, a
  // mouse arriving. The browser says so, so there is no reason to be frozen
  // on whatever was true when the page loaded.
  try {
    window.matchMedia?.(COARSE_POINTER)?.addEventListener?.('change', (event) => {
      usingTouch.value = Boolean(event?.matches);
    });
  } catch (_) {
    /* A browser that cannot be asked is one that cannot change its answer. */
  }
};

export function useInputMode() {
  followTheReader();
  return { isTouchDevice: computed(() => usingTouch.value) };
}

/** For tests, which need the application to start again from a known place. */
export const __resetInputMode = () => {
  usingTouch.value = primaryPointerIsCoarse();
};
