import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Who the application thinks you are.
 *
 * Forty-eight statements uncovered on the store every navigation guard reads.
 * Two of its answers are worth more than the rest:
 *
 * `isAuthenticated` is true when authentication is *switched off*, because a
 * deployment with no accounts must not send everybody to a login screen that
 * cannot be satisfied. That is correct and it is also the shape of a very bad
 * bug if the flag is ever read the other way round.
 *
 * And a failed status lookup does not authenticate anybody. The catch here
 * records the error and leaves `currentUser` as it was — so a server that is
 * down leaves a visitor signed out rather than signed in, which is the only
 * safe direction for that failure.
 *
 * The guest session is cleared on every route into an account. A leftover
 * `guestSessionId` alongside a real user makes `isGuest` and `isAuthenticated`
 * both true, and the two are read by different screens.
 */

const fetchAuthStatus = vi.fn();
const loginApi = vi.fn();
const logoutApi = vi.fn();
const setupAccountApi = vi.fn();
const submitTotpCodeApi = vi.fn();
const signInWithPasskeyApi = vi.fn();

vi.mock('@/api', () => ({
  fetchAuthStatus: (...a) => fetchAuthStatus(...a),
  login: (...a) => loginApi(...a),
  submitTotpCode: (...a) => submitTotpCodeApi(...a),
  signInWithPasskey: (...a) => signInWithPasskeyApi(...a),
  logout: (...a) => logoutApi(...a),
  setupAccount: (...a) => setupAccountApi(...a),
}));

import { useAuthStore } from './auth';

const USER = { id: 'u1', email: 'u@example.com', roles: ['admin'] };

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  [fetchAuthStatus, loginApi, logoutApi, setupAccountApi].forEach((m) => m.mockReset());
  fetchAuthStatus.mockResolvedValue({
    authEnabled: true,
    requiresSetup: false,
    authMode: 'local',
    strategies: { local: true, oidc: false },
    user: null,
  });
});

describe('reading the status', () => {
  it('takes what the server said', async () => {
    fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      requiresSetup: true,
      authMode: 'oidc',
      strategies: { local: false, oidc: true },
      user: null,
    });
    const store = useAuthStore();

    await store.initialize();

    expect(store.requiresSetup).toBe(true);
    expect(store.authMode).toBe('oidc');
    expect(store.strategies).toEqual({ local: false, oidc: true });
    expect(store.hasStatus).toBe(true);
    expect(store.isLoading).toBe(false);
  });

  it('shares one request between callers that arrive together', async () => {
    const store = useAuthStore();

    await Promise.all([store.initialize(), store.initialize(), store.initialize()]);

    expect(fetchAuthStatus).toHaveBeenCalledTimes(1);
  });

  it('can be asked again once the first has finished', async () => {
    const store = useAuthStore();
    await store.initialize();

    await store.initialize();

    expect(fetchAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('defaults the mode and the strategies when the server omits them', async () => {
    fetchAuthStatus.mockResolvedValue({ authEnabled: true, requiresSetup: false, user: null });
    const store = useAuthStore();

    await store.initialize();

    expect(store.authMode).toBe('local');
    // A server that says nothing offers a password and nothing else: no
    // provider, and no passkey button on a screen that cannot know yet.
    expect(store.strategies).toEqual({ local: true, oidc: false, passkey: false });
  });

  /**
   * The failure direction that matters. A server that is unreachable must leave
   * a visitor signed out, never signed in.
   */
  it('records the failure and leaves nobody signed in', async () => {
    fetchAuthStatus.mockRejectedValue(new Error('server unreachable'));
    const store = useAuthStore();

    await store.initialize();

    expect(store.lastError).toBe('server unreachable');
    expect(store.currentUser).toBeNull();
    expect(store.isAuthenticated).toBe(false);
    expect(store.hasStatus).toBe(true);
  });

  it('says something even when what was thrown is not an Error', async () => {
    fetchAuthStatus.mockRejectedValue('nope');
    const store = useAuthStore();

    await store.initialize();

    expect(store.lastError).toBeTruthy();
  });

  it('clears the busy flag after a failure, so it can be tried again', async () => {
    fetchAuthStatus.mockRejectedValue(new Error('offline'));
    const store = useAuthStore();
    await store.initialize();

    fetchAuthStatus.mockResolvedValue({ authEnabled: true, user: USER });
    await store.initialize();

    expect(store.isAuthenticated).toBe(true);
  });
});

describe('a deployment with authentication switched off', () => {
  /**
   * Nobody can sign in, so everybody is treated as signed in. Reading this the
   * other way round locks every visitor out of an application that has no login
   * to offer them.
   */
  it('treats everybody as signed in', async () => {
    fetchAuthStatus.mockResolvedValue({ authEnabled: false, user: null });
    const store = useAuthStore();

    await store.initialize();

    expect(store.authEnabled).toBe(false);
    expect(store.isAuthenticated).toBe(true);
  });

  /** There is nothing to set up when there are no accounts. */
  it('never asks for setup', async () => {
    fetchAuthStatus.mockResolvedValue({ authEnabled: false, requiresSetup: true, user: null });
    const store = useAuthStore();

    await store.initialize();

    expect(store.requiresSetup).toBe(false);
  });

  it('treats a missing authEnabled as enabled rather than off', async () => {
    fetchAuthStatus.mockResolvedValue({ requiresSetup: false, user: null });
    const store = useAuthStore();

    await store.initialize();

    expect(store.authEnabled).toBe(true);
    expect(store.isAuthenticated).toBe(false);
  });
});

describe('the guest session', () => {
  it('makes a visitor a guest while nobody is signed in', async () => {
    sessionStorage.setItem('guestSessionId', 'g1');
    const store = useAuthStore();

    await store.initialize();

    expect(store.isGuest).toBe(true);
  });

  it('is not a guest with no session at all', async () => {
    const store = useAuthStore();

    await store.initialize();

    expect(store.isGuest).toBe(false);
  });

  /**
   * A leftover guest id beside a real user makes `isGuest` and
   * `isAuthenticated` both true, and different screens read different ones.
   */
  it.each([
    ['reading a status that names a user', async (store) => store.initialize()],
    ['signing in', async (store) => store.login({ email: 'u@example.com', password: 'x' })],
    [
      'setting up the first account',
      async (store) => store.setupAccount({ email: 'u@example.com', username: 'u', password: 'x' }),
    ],
  ])('is cleared by %s', async (_label, act) => {
    sessionStorage.setItem('guestSessionId', 'g1');
    fetchAuthStatus.mockResolvedValue({ authEnabled: true, user: USER });
    loginApi.mockResolvedValue({ user: USER });
    setupAccountApi.mockResolvedValue({ user: USER });
    const store = useAuthStore();

    await act(store);

    expect(sessionStorage.getItem('guestSessionId')).toBeNull();
    expect(store.isGuest).toBe(false);
  });

  it('is left alone when the status names nobody', async () => {
    sessionStorage.setItem('guestSessionId', 'g1');
    const store = useAuthStore();

    await store.initialize();

    expect(sessionStorage.getItem('guestSessionId')).toBe('g1');
  });
});

describe('signing in', () => {
  it('keeps the user the server returned', async () => {
    loginApi.mockResolvedValue({ user: USER });
    const store = useAuthStore();

    await store.login({ email: 'u@example.com', password: 'secret' });

    expect(store.currentUser).toEqual(USER);
    expect(store.isAuthenticated).toBe(true);
    expect(store.hasStatus).toBe(true);
  });

  it('lets a rejection reach the form rather than swallowing it', async () => {
    loginApi.mockRejectedValue(new Error('Invalid credentials'));
    const store = useAuthStore();

    await expect(store.login({ email: 'u@example.com', password: 'wrong' })).rejects.toThrow(
      'Invalid credentials'
    );
    expect(store.isAuthenticated).toBe(false);
  });

  it('clears a previous error before trying again', async () => {
    fetchAuthStatus.mockRejectedValue(new Error('offline'));
    const store = useAuthStore();
    await store.initialize();
    loginApi.mockResolvedValue({ user: USER });

    await store.login({ email: 'u@example.com', password: 'x' });

    expect(store.lastError).toBeNull();
  });

  /** A server answering without a user leaves nobody signed in, not undefined. */
  it('treats an answer with no user as nobody', async () => {
    loginApi.mockResolvedValue({});
    const store = useAuthStore();

    await store.login({ email: 'u@example.com', password: 'x' });

    expect(store.currentUser).toBeNull();
    expect(store.isAuthenticated).toBe(false);
  });
});

describe('setting up the first account', () => {
  it('signs the new account in and stops asking for setup', async () => {
    setupAccountApi.mockResolvedValue({ user: USER });
    const store = useAuthStore();
    store.requiresSetup = true;

    await store.setupAccount({ email: 'u@example.com', username: 'u', password: 'x' });

    expect(store.requiresSetup).toBe(false);
    expect(store.currentUser).toEqual(USER);
  });

  it('lets a rejection reach the form', async () => {
    setupAccountApi.mockRejectedValue(new Error('Password too short'));
    const store = useAuthStore();

    await expect(
      store.setupAccount({ email: 'u@example.com', username: 'u', password: 'x' })
    ).rejects.toThrow('Password too short');
  });
});

describe('signing out', () => {
  it('forgets the user', async () => {
    loginApi.mockResolvedValue({ user: USER });
    logoutApi.mockResolvedValue();
    const store = useAuthStore();
    await store.login({ email: 'u@example.com', password: 'x' });

    await store.logout();

    expect(store.currentUser).toBeNull();
    expect(store.isAuthenticated).toBe(false);
  });

  /**
   * The session cookie may already be gone, or the server unreachable. Either
   * way the visitor asked to sign out, and the client must not refuse.
   */
  it('forgets the user even when the request fails', async () => {
    loginApi.mockResolvedValue({ user: USER });
    logoutApi.mockRejectedValue(new Error('already logged out'));
    const store = useAuthStore();
    await store.login({ email: 'u@example.com', password: 'x' });

    await expect(store.logout()).resolves.toBeUndefined();
    expect(store.currentUser).toBeNull();
  });
});

describe('clearing the error', () => {
  it('empties it', async () => {
    fetchAuthStatus.mockRejectedValue(new Error('offline'));
    const store = useAuthStore();
    await store.initialize();

    store.clearError();

    expect(store.lastError).toBeNull();
  });
});

/**
 * The half-signed-in state.
 *
 * Between a right password and a code, nobody is signed in. Every guard in the
 * application reads `isAuthenticated` off this store, so the rule that matters
 * is that nothing here sets a user until the second step is answered.
 */
describe('a sign-in waiting for a code', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    [fetchAuthStatus, loginApi, submitTotpCodeApi, logoutApi].forEach((mock) => mock.mockReset());
  });

  it('holds the sign-in rather than finishing it', async () => {
    loginApi.mockResolvedValue({ totpRequired: true });
    const store = useAuthStore();

    const outcome = await store.login({ identifier: 'someone', password: 'secret' });

    expect(outcome).toEqual({ totpRequired: true });
    expect(store.totpPending).toBe(true);
    expect(store.currentUser).toBeNull();
    expect(store.isAuthenticated).toBe(false);
  });

  it('finishes on the code, and says what was used', async () => {
    loginApi.mockResolvedValue({ totpRequired: true });
    submitTotpCodeApi.mockResolvedValue({
      user: USER,
      usedRecoveryCode: true,
      recoveryCodesLeft: 9,
    });
    const store = useAuthStore();
    await store.login({ identifier: 'someone', password: 'secret' });

    const outcome = await store.submitTotpCode('12345678');

    expect(submitTotpCodeApi).toHaveBeenCalledWith('12345678');
    expect(outcome).toEqual({ usedRecoveryCode: true, recoveryCodesLeft: 9 });
    expect(store.totpPending).toBe(false);
    expect(store.currentUser).toEqual(USER);
  });

  /** A reload in the middle of one lands back on the code, not on the password. */
  it('reads the waiting state back from the server', async () => {
    fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      strategies: { local: true, oidc: false },
      totpPending: true,
      user: null,
    });
    const store = useAuthStore();

    await store.initialize();

    expect(store.totpPending).toBe(true);
    expect(store.isAuthenticated).toBe(false);
  });

  it('forgets it when the session ends', async () => {
    loginApi.mockResolvedValue({ totpRequired: true });
    logoutApi.mockResolvedValue(undefined);
    const store = useAuthStore();
    await store.login({ identifier: 'someone', password: 'secret' });

    await store.logout();
    expect(store.totpPending).toBe(false);

    await store.login({ identifier: 'someone', password: 'secret' });
    store.forgetSession();
    expect(store.totpPending).toBe(false);
  });

  /** The server holds the half-open sign-in, so the server is the one told. */
  it('gives up on it, and says so, when somebody goes back to the password', async () => {
    loginApi.mockResolvedValue({ totpRequired: true });
    logoutApi.mockResolvedValue(undefined);
    const store = useAuthStore();
    await store.login({ identifier: 'someone', password: 'secret' });

    await store.cancelTotp();

    expect(store.totpPending).toBe(false);
    expect(logoutApi).toHaveBeenCalled();
  });

  it('gives up on it even when the server cannot be reached', async () => {
    loginApi.mockResolvedValue({ totpRequired: true });
    logoutApi.mockRejectedValue(new Error('offline'));
    const store = useAuthStore();
    await store.login({ identifier: 'someone', password: 'secret' });

    await store.cancelTotp();

    expect(store.totpPending).toBe(false);
  });
});

/**
 * A passkey, which signs somebody in without naming them first.
 *
 * It ends in one of the two places a password ends: signed in, or waiting for
 * a code. The second only happens for a passkey that was not unlocked — one
 * that was is already the second factor, and the server says so by answering
 * with the account rather than with a question.
 */
describe('signing in with a passkey', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    [fetchAuthStatus, loginApi, signInWithPasskeyApi, submitTotpCodeApi].forEach((mock) =>
      mock.mockReset()
    );
  });

  it('signs the account in, with nothing typed', async () => {
    signInWithPasskeyApi.mockResolvedValue({ user: USER });
    const store = useAuthStore();

    const outcome = await store.signInWithPasskey();

    expect(outcome).toEqual({ totpRequired: false });
    expect(store.currentUser).toEqual(USER);
    expect(store.isAuthenticated).toBe(true);
    expect(store.totpPending).toBe(false);
  });

  it('waits for a code when the passkey was not unlocked', async () => {
    signInWithPasskeyApi.mockResolvedValue({ totpRequired: true });
    const store = useAuthStore();

    const outcome = await store.signInWithPasskey();

    expect(outcome).toEqual({ totpRequired: true });
    expect(store.totpPending).toBe(true);
    expect(store.currentUser).toBeNull();
    expect(store.isAuthenticated).toBe(false);
  });

  it('lets the browser’s refusal through, signing nobody in', async () => {
    const refusal = new Error('not allowed');
    refusal.name = 'NotAllowedError';
    signInWithPasskeyApi.mockRejectedValue(refusal);
    const store = useAuthStore();

    await expect(store.signInWithPasskey()).rejects.toBe(refusal);
    expect(store.currentUser).toBeNull();
    expect(store.isAuthenticated).toBe(false);
  });
});
