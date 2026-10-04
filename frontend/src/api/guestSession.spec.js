import { describe, it, expect, beforeEach } from 'vitest';
import { computed } from 'vue';
import {
  forgetGuestSession,
  guestSessionId,
  guestSessionShareToken,
  rememberGuestSession,
} from './guestSession.js';

beforeEach(() => forgetGuestSession());

describe('the share session a tab carries', () => {
  it('is kept, and dropped, with the share it was issued for', () => {
    rememberGuestSession('g1', 'TOKEN');
    expect(guestSessionId.value).toBe('g1');
    expect(guestSessionShareToken.value).toBe('TOKEN');
    expect(sessionStorage.getItem('guestSessionId')).toBe('g1');

    forgetGuestSession();
    expect(guestSessionId.value).toBeNull();
    expect(guestSessionShareToken.value).toBeNull();
    expect(sessionStorage.getItem('guestSessionId')).toBeNull();
  });

  /**
   * The defect this module exists for.
   *
   * Asking `sessionStorage` inside a computed, behind a `&&` that short-circuits
   * when there is no session, leaves that computed with no reactive value read
   * at all — so the first answer is the only answer. Behind an authentication
   * proxy the first refused request asked before the share had handed a session
   * out, and the page spent the rest of its life believing a visitor with no
   * account was a signed-in one.
   */
  it('is seen by whatever asked before it existed', () => {
    const carries = computed(() => Boolean(guestSessionId.value));

    expect(carries.value).toBe(false);
    rememberGuestSession('g1', 'TOKEN');

    expect(carries.value).toBe(true);
  });
});
