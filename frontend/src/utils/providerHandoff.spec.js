import { beforeEach, describe, expect, it } from 'vitest';

import {
  forgetHandedOff,
  markHandedOff,
  markSignedOut,
  takeHandedOffRecently,
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
    expect(takeHandedOffRecently()).toBe(false);
  });

  it('remembers a hand-off that has just happened', () => {
    markHandedOff();

    expect(takeHandedOffRecently()).toBe(true);
  });

  /**
   * A round trip through a provider takes seconds. An hour later the same mark
   * says nothing about the session that has just run out, and reading it as
   * "you came back with nothing" would refuse a hand-off that would have
   * worked.
   */
  it('says nothing about a hand-off from hours ago', () => {
    markHandedOff();

    expect(takeHandedOffRecently(Date.now() + 60 * 60 * 1000)).toBe(false);
  });

  /** Consumed whether it was acted on or not, or it would refuse the next one. */
  it('is consumed even when it was too old to matter', () => {
    markHandedOff();
    takeHandedOffRecently(Date.now() + 60 * 60 * 1000);

    expect(window.sessionStorage.getItem('oidcHandoff')).toBeNull();
  });

  it('is dropped outright once a session was obtained', () => {
    markHandedOff();
    forgetHandedOff();

    expect(takeHandedOffRecently()).toBe(false);
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
