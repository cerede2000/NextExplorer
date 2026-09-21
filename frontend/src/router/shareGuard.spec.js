import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getShareInfo = vi.fn();
vi.mock('@/api/shares.api', () => ({ getShareInfo: (...args) => getShareInfo(...args) }));

import { signedInMayOpenShare, resetShareGuard } from './shareGuard';

/**
 * A signed-in account arriving at a folder inside a password-protected share.
 *
 * The server asks it for the password unless it owns the share or has already
 * given it, and the page cannot tell which: the proof is a cookie it cannot
 * read. So the guard asks the server, and only when the share says this viewer
 * needs a password at all.
 */

let fetchMock;

beforeEach(() => {
  resetShareGuard();
  getShareInfo.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a signed-in account opening a share', () => {
  it('goes straight in when the share asks it for no password', async () => {
    getShareInfo.mockResolvedValue({ requiresPassword: false });

    expect(await signedInMayOpenShare('tok', 'bob')).toBe(true);
    // Nothing else to ask: the owner, or a share without a password.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is sent to the password when the server refuses it the share', async () => {
    getShareInfo.mockResolvedValue({ requiresPassword: true });
    fetchMock.mockResolvedValue({ status: 401, ok: false });

    expect(await signedInMayOpenShare('tok', 'bob')).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/share/tok/access'),
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('goes in once the server says it has given the password, and is not asked again', async () => {
    getShareInfo.mockResolvedValue({ requiresPassword: true });
    fetchMock.mockResolvedValue({ status: 200, ok: true });

    expect(await signedInMayOpenShare('tok', 'bob')).toBe(true);
    expect(await signedInMayOpenShare('tok', 'bob')).toBe(true);
    // One question per share and account while the tab is open, not one per
    // folder the account moves through.
    expect(getShareInfo).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again for another account in the same tab', async () => {
    getShareInfo.mockResolvedValue({ requiresPassword: true });
    fetchMock.mockResolvedValueOnce({ status: 200, ok: true });
    fetchMock.mockResolvedValueOnce({ status: 401, ok: false });

    expect(await signedInMayOpenShare('tok', 'bob')).toBe(true);
    expect(await signedInMayOpenShare('tok', 'carol')).toBe(false);
  });

  it('leaves an unknown share to the view, which says what is wrong with it', async () => {
    getShareInfo.mockRejectedValue(new Error('Share not found'));

    expect(await signedInMayOpenShare('gone', 'bob')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
