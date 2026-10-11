import { beforeEach, describe, expect, it } from 'vitest';

import {
  forgetHandedOff,
  goingInCircles,
  markHandedOff,
  markSignedOut,
  takeSignedOut,
} from './providerHandoff';

/**
 * The marks a trip to the identity provider leaves behind.
 *
 * Both are read once and removed as they are read, and that is the whole
 * substance of the module: a mark that survives the screen it was left for
 * answers a later question it knows nothing about. The sign-out mark used to,
 * and the next session to run out in that tab stopped at a button instead of
 * going to the provider.
 */
describe('a mark left for the screen the browser comes back to', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('is there for the screen that reads it', () => {
    markSignedOut();

    expect(takeSignedOut()).toBe(true);
  });

  it('is gone for the next one', () => {
    markSignedOut();
    takeSignedOut();

    expect(takeSignedOut()).toBe(false);
  });

  it('says nothing when nobody left one', () => {
    expect(takeSignedOut()).toBe(false);
    expect(goingInCircles()).toBe(false);
  });

  it('survives a browser that refuses to remember anything', () => {
    const held = window.sessionStorage;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('The browser is in private mode.');
      },
    });

    expect(() => markSignedOut()).not.toThrow();
    expect(takeSignedOut()).toBe(false);

    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: held });
  });
});

/**
 * Telling a circle from somebody trying again.
 *
 * One hand-off that came back without a session says almost nothing. Somebody
 * who walked away from the provider's page and then opened the address again
 * has done exactly that, and what they want is to be sent to the provider.
 * Reading their one unfinished trip as a circle stopped them at a wall they
 * had done nothing to deserve — which is how this was reported.
 *
 * A circle is repetition: the lap takes well under a second because nobody is
 * typing anything.
 */
describe('going round in circles', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('is not what one unfinished trip is', () => {
    markHandedOff();

    expect(goingInCircles()).toBe(false);
  });

  it('is not what somebody who tried twice is doing', () => {
    markHandedOff();
    markHandedOff();

    expect(goingInCircles()).toBe(false);
  });

  it('is three laps in the same breath', () => {
    markHandedOff();
    markHandedOff();
    markHandedOff();

    expect(goingInCircles()).toBe(true);
  });

  /** Three laps spread over an afternoon are three people trying, not a circle. */
  it('is not three laps spread out', () => {
    const start = Date.now();
    markHandedOff(start);
    markHandedOff(start + 60 * 1000);
    markHandedOff(start + 120 * 1000);

    expect(goingInCircles(start + 120 * 1000)).toBe(false);
  });

  /** Asking is not answering: the laps are what the next hand-off counts from. */
  it('is still true when asked twice', () => {
    markHandedOff();
    markHandedOff();
    markHandedOff();

    expect(goingInCircles()).toBe(true);
    expect(goingInCircles()).toBe(true);
  });

  it('is over once a session was obtained', () => {
    markHandedOff();
    markHandedOff();
    markHandedOff();

    forgetHandedOff();

    expect(goingInCircles()).toBe(false);
  });

  /** A single timestamp is what an earlier version left in this tab. */
  it('reads what an older version wrote as no laps at all', () => {
    window.sessionStorage.setItem('oidcHandoff', String(Date.now()));

    expect(goingInCircles()).toBe(false);
    markHandedOff();
    expect(goingInCircles()).toBe(false);
  });
});
