import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * This guard decides whether a visitor sees the shared files or a password
 * prompt, before the view loads. It had no test at all, and the backend half
 * of the same rule shipped broken once already.
 */

const getShareInfo = vi.fn();
const getGuestSessionShareToken = vi.fn();

vi.mock('@/api/shares.api', () => ({ getShareInfo: (...args) => getShareInfo(...args) }));
vi.mock('@/api', () => ({
  getGuestSessionShareToken: (...args) => getGuestSessionShareToken(...args),
}));

const { resolveShareAccess, resetShareInfoCache } = await import('./shareGuard');

const anonymous = { isAuthenticated: false, currentUser: null };
const signedIn = (id = 'user-1') => ({ isAuthenticated: true, currentUser: { id } });

const open = (auth, shareToken = 'TOKEN') =>
  resolveShareAccess({ shareToken, fullPath: `/browse/share/${shareToken}`, auth });

beforeEach(() => {
  resetShareInfoCache();
  getShareInfo.mockReset();
  getGuestSessionShareToken.mockReset();
  sessionStorage.clear();
});

describe('Share guard', () => {
  it('sends an anonymous visitor to the password prompt', async () => {
    expect(await open(anonymous)).toEqual({
      name: 'ShareLogin',
      params: { token: 'TOKEN' },
      query: { redirect: '/browse/share/TOKEN' },
    });
    // No point asking the backend: an anonymous visitor needs the prompt
    // whether or not the link is protected.
    expect(getShareInfo).not.toHaveBeenCalled();
  });

  it('lets a verified guest session through without asking the backend', async () => {
    sessionStorage.setItem('guestSessionId', 'guest-1');
    getGuestSessionShareToken.mockReturnValue('TOKEN');

    expect(await open(anonymous)).toBe(true);
    expect(getShareInfo).not.toHaveBeenCalled();
  });

  it('honours a guest session read before auth cleared it', async () => {
    // auth.initialize() removes guestSessionId as soon as it sees a signed-in
    // user. The router reads the session before that call and passes it in;
    // reading it here instead would send a visitor who already typed the
    // password back to the prompt on every reload.
    sessionStorage.clear();
    getGuestSessionShareToken.mockReturnValue(null);

    const decision = await resolveShareAccess({
      shareToken: 'TOKEN',
      fullPath: '/browse/share/TOKEN',
      auth: signedIn(),
      guestSession: { id: 'guest-1', shareToken: 'TOKEN' },
    });

    expect(decision).toBe(true);
    expect(getShareInfo).not.toHaveBeenCalled();
  });

  it('ignores a guest session belonging to another share', async () => {
    sessionStorage.setItem('guestSessionId', 'guest-1');
    getGuestSessionShareToken.mockReturnValue('OTHER-TOKEN');

    expect(await open(anonymous)).toMatchObject({ name: 'ShareLogin' });
  });

  it('lets a signed-in visitor through when the link has no password', async () => {
    getShareInfo.mockResolvedValue({ requiresPassword: false });

    expect(await open(signedIn())).toBe(true);
  });

  it('sends a signed-in stranger to the prompt when the link is protected', async () => {
    getShareInfo.mockResolvedValue({ requiresPassword: true });

    expect(await open(signedIn())).toMatchObject({ name: 'ShareLogin' });
  });

  it('does not send the owner to a prompt for their own share', async () => {
    // requiresPassword is computed by the backend for the caller, so the owner
    // gets false even though the link carries a password.
    getShareInfo.mockResolvedValue({ hasPassword: true, requiresPassword: false });

    expect(await open(signedIn('owner-1'))).toBe(true);
  });

  it('lets the view surface the error when the share cannot be read', async () => {
    getShareInfo.mockRejectedValue(new Error('network down'));

    // Redirecting here would hide the real problem behind a password prompt.
    expect(await open(signedIn())).toBe(true);
  });
});

describe('Share info cache', () => {
  it('asks once per token, however many folders are opened', async () => {
    getShareInfo.mockResolvedValue({ requiresPassword: false });
    const auth = signedIn();

    await open(auth);
    await open(auth);
    await open(auth);

    // Without this, every folder change paid a serialized round-trip.
    expect(getShareInfo).toHaveBeenCalledTimes(1);
  });

  it('asks again for a different viewer', async () => {
    getShareInfo.mockResolvedValue({ requiresPassword: false });

    await open(signedIn('user-1'));
    await open(signedIn('user-2'));

    // The answer depends on who is asking: the owner skips the prompt.
    expect(getShareInfo).toHaveBeenCalledTimes(2);
  });

  it('asks again for a different token', async () => {
    getShareInfo.mockResolvedValue({ requiresPassword: false });
    const auth = signedIn();

    await open(auth, 'TOKEN-A');
    await open(auth, 'TOKEN-B');

    expect(getShareInfo).toHaveBeenCalledTimes(2);
  });

  it('retries after a failure instead of caching it', async () => {
    getShareInfo.mockRejectedValueOnce(new Error('network down'));
    getShareInfo.mockResolvedValueOnce({ requiresPassword: true });
    const auth = signedIn();

    expect(await open(auth)).toBe(true);
    expect(await open(auth)).toMatchObject({ name: 'ShareLogin' });
    expect(getShareInfo).toHaveBeenCalledTimes(2);
  });
});
