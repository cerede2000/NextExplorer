import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which pointer the reader is using, and the machine that lied about it.
 *
 * Reported from a Lenovo ThinkBook running Windows 11 with no touch screen:
 * the file listing opened a folder on a single click and would not let
 * anything be selected without pressing a button that only exists on a phone.
 * The page's own answers, side by side with what Windows said of itself:
 *
 *   navigator.maxTouchPoints  16        SM_MAXIMUMTOUCHES  0
 *   (pointer: coarse)         false     SM_DIGITIZER       0
 *   'ontouchstart' in window  false
 *
 * The system declared no digitizer of any kind and the page still saw sixteen
 * touch points — something between the two rewrote it. Which is the lesson
 * rather than the curiosity: a count of touch points is a claim about the
 * machine that nobody can vouch for, and it was deciding how every click in
 * the application was read.
 */

const asDevice = ({ touchPoints = 0, coarse = false, touchEvents = false }) => {
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    value: touchPoints,
    configurable: true,
  });
  if (touchEvents) window.ontouchstart = null;
  else delete window.ontouchstart;

  const listeners = new Set();
  window.matchMedia = vi.fn((query) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    media: query,
    addEventListener: (_name, listener) => listeners.add(listener),
    removeEventListener: (_name, listener) => listeners.delete(listener),
  }));
  return { tellThePointerChanged: (matches) => listeners.forEach((l) => l({ matches })) };
};

const touchWith = (pointerType) => {
  const event = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  window.dispatchEvent(event);
};

/** Fresh module state, since the mode is one thing for the whole application. */
const inputMode = async () => {
  vi.resetModules();
  return import('./useInputMode');
};

let realMatchMedia;

beforeEach(() => {
  realMatchMedia = window.matchMedia;
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  delete window.ontouchstart;
  vi.restoreAllMocks();
});

describe('the pointer the reader is using', () => {
  it('is not touch on a machine that merely claims sixteen touch points', async () => {
    asDevice({ touchPoints: 16, coarse: false, touchEvents: false });

    const { useInputMode } = await inputMode();

    expect(useInputMode().isTouchDevice.value).toBe(false);
  });

  it('is touch where the primary pointer really is coarse', async () => {
    asDevice({ touchPoints: 5, coarse: true });

    const { useInputMode } = await inputMode();

    expect(useInputMode().isTouchDevice.value).toBe(true);
  });

  /**
   * The laptop with a touchscreen, which is the case neither a capability nor
   * a media query answers on its own: it can be touched and is being clicked.
   */
  it('follows the reader, a finger then a mouse', async () => {
    asDevice({ touchPoints: 10, coarse: false });
    const { useInputMode } = await inputMode();
    const { isTouchDevice } = useInputMode();

    expect(isTouchDevice.value).toBe(false);

    touchWith('touch');
    expect(isTouchDevice.value).toBe(true);

    touchWith('mouse');
    expect(isTouchDevice.value).toBe(false);
  });

  /** A pen can hit a checkbox, so it is read as the pointer it is. */
  it('reads a pen as a pointer rather than a finger', async () => {
    asDevice({ coarse: true });
    const { useInputMode } = await inputMode();
    const { isTouchDevice } = useInputMode();

    expect(isTouchDevice.value).toBe(true);
    touchWith('pen');
    expect(isTouchDevice.value).toBe(false);
  });

  /**
   * Every row, the toolbar and the drag handling read this, and they have to
   * agree. A computed made per caller out of nothing reactive is also one
   * that is worked out once and never again.
   */
  it('is one answer for the whole application, and it is not frozen', async () => {
    asDevice({ coarse: false });
    const { useInputMode } = await inputMode();
    const aRow = useInputMode().isTouchDevice;
    const theToolbar = useInputMode().isTouchDevice;

    expect(aRow.value).toBe(false);
    touchWith('touch');

    expect(aRow.value).toBe(true);
    expect(theToolbar.value).toBe(true);
  });

  it('hears the primary pointer change under a running session', async () => {
    const device = asDevice({ coarse: false });
    const { useInputMode } = await inputMode();
    const { isTouchDevice } = useInputMode();

    expect(isTouchDevice.value).toBe(false);
    device.tellThePointerChanged(true);
    expect(isTouchDevice.value).toBe(true);
  });

  it('answers a browser that cannot be asked, rather than throwing', async () => {
    delete window.matchMedia;

    const { useInputMode } = await inputMode();

    expect(useInputMode().isTouchDevice.value).toBe(false);
  });
});
