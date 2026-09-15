import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The share endpoints and the links built from a share token. The endpoints
 * are what the share dialog and the shared-with-me screens call; the links are
 * what people paste into an email, where nothing checks them before a recipient
 * clicks. A name with a `#` or a `%` left unencoded opens a different file, or
 * none, for somebody who cannot tell the link was wrong.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal()),
  requestJson,
}));

const api = await import('./shares.api');

const call = () => {
  const [endpoint, options] = requestJson.mock.calls.at(-1);
  return {
    endpoint,
    method: options?.method,
    body: options?.body ? JSON.parse(options.body) : null,
  };
};

const origin = window.location.origin;

beforeEach(() => {
  requestJson.mockClear();
  sessionStorage.clear();
});

describe('the shares API', () => {
  it('creates a share of a path with every permission the dialog chose', async () => {
    await api.createShare({
      sourcePath: '/Projects/Q3 & Q4/',
      accessMode: 'readwrite',
      allowDelete: false,
      allowCreateFolder: false,
      allowCreateFile: true,
      allowUpload: false,
      allowDownload: true,
      sharingType: 'users',
      password: null,
      userIds: ['u1', 'u2'],
      expiresAt: '2026-10-01T00:00:00.000Z',
      label: 'Client review',
      versionsVisible: false,
      versionsDownload: false,
    });

    expect(call()).toEqual({
      endpoint: '/api/shares',
      method: 'POST',
      body: {
        sourcePath: 'Projects/Q3 & Q4',
        accessMode: 'readwrite',
        allowDelete: false,
        allowCreateFolder: false,
        allowCreateFile: true,
        allowUpload: false,
        allowDownload: true,
        sharingType: 'users',
        password: null,
        userIds: ['u1', 'u2'],
        expiresAt: '2026-10-01T00:00:00.000Z',
        label: 'Client review',
        versionsVisible: false,
        versionsDownload: false,
      },
    });
  });

  /**
   * The server decides a share's history options by its kind when they are not
   * sent. Dropped on the way, a named share the owner unticked still showed
   * its files' history, and a link for anyone the owner ticked showed none.
   */
  it('sends the history options the dialog chose, whichever the kind of share', async () => {
    await api.createShare({
      sourcePath: 'Projects',
      sharingType: 'anyone',
      versionsVisible: true,
      versionsDownload: true,
    });
    expect(call().body).toMatchObject({ versionsVisible: true, versionsDownload: true });

    await api.createShare({ sourcePath: 'Projects', sharingType: 'users', versionsVisible: false });
    expect(call().body.versionsVisible).toBe(false);
  });

  it('creates a read-only link for anyone when nothing else is chosen', async () => {
    await api.createShare({ sourcePath: 'Projects' });

    expect(call().body).toEqual({
      sourcePath: 'Projects',
      accessMode: 'readonly',
      allowDelete: true,
      allowCreateFolder: true,
      allowCreateFile: true,
      allowUpload: true,
      allowDownload: true,
      sharingType: 'anyone',
      password: null,
      userIds: [],
      expiresAt: null,
      label: null,
    });
  });

  it('lists the shares made by the current user, and the ones made for them', async () => {
    await api.getMyShares();
    expect(call()).toEqual({ endpoint: '/api/shares', method: 'GET', body: null });

    await api.getSharedWithMe();
    expect(call()).toEqual({ endpoint: '/api/shares/shared-with-me', method: 'GET', body: null });
  });

  it('updates a share with exactly the changes given, so the server leaves the rest alone', async () => {
    await api.updateShare('share-1', { label: 'Renamed', password: null });

    expect(call()).toEqual({
      endpoint: '/api/shares/share-1',
      method: 'PUT',
      body: { label: 'Renamed', password: null },
    });
  });

  it('deletes a share on the management route', async () => {
    await api.deleteShare('share-1');

    expect(call()).toEqual({ endpoint: '/api/shares/share-1', method: 'DELETE', body: null });
  });

  it('reads, unlocks and enters a public share by its token', async () => {
    await api.getShareInfo('tok123');
    expect(call()).toEqual({ endpoint: '/api/share/tok123/info', method: 'GET', body: null });

    await api.verifySharePassword('tok123', 'p&ss #1');
    expect(call()).toEqual({
      endpoint: '/api/share/tok123/verify',
      method: 'POST',
      body: { password: 'p&ss #1' },
    });

    await api.accessShare('tok123');
    expect(call()).toEqual({ endpoint: '/api/share/tok123/access', method: 'GET', body: null });
  });

  it('browses a share at its top, keeping the trailing slash the route needs', async () => {
    await api.browseShare('tok123');
    expect(call().endpoint).toBe('/api/share/tok123/browse/');

    await api.browseShare('tok123', '/');
    expect(call().endpoint).toBe('/api/share/tok123/browse/');
  });

  it('browses further in, one encoded segment at a time, and can be cancelled', async () => {
    const { signal } = new AbortController();

    await api.browseShare('tok123', '/Q3 & Q4/#drafts/100%/', { signal });

    const [endpoint, options] = requestJson.mock.calls.at(-1);
    expect(endpoint).toBe('/api/share/tok123/browse/Q3%20%26%20Q4/%23drafts/100%25');
    expect(options).toEqual({ method: 'GET', signal });
  });
});

describe('the guest session of a share', () => {
  it('remembers the session and the share it was opened for', () => {
    api.setGuestSession('guest-1', 'tok123');

    expect(sessionStorage.getItem('guestSessionId')).toBe('guest-1');
    expect(api.getGuestSessionShareToken()).toBe('tok123');
  });

  it('keeps the share it was opened for when only the session is renewed', () => {
    api.setGuestSession('guest-1', 'tok123');
    api.setGuestSession('guest-2');

    expect(sessionStorage.getItem('guestSessionId')).toBe('guest-2');
    expect(api.getGuestSessionShareToken()).toBe('tok123');
  });

  it('forgets both when the session ends', () => {
    api.setGuestSession('guest-1', 'tok123');
    api.setGuestSession(null);

    expect(sessionStorage.getItem('guestSessionId')).toBeNull();
    expect(api.getGuestSessionShareToken()).toBeNull();
  });
});

describe('the links built from a share', () => {
  it('offers the direct link modes the server and the editor understand', () => {
    expect(api.DIRECT_SHARE_FILE_MODES.map((mode) => mode.value)).toEqual([
      'auto',
      'inline',
      'raw',
      'editor',
      'download',
    ]);
  });

  it('points the share itself at the page that opens it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await expect(api.copyShareUrl('tok123')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith(`${origin}/share/tok123`);
  });

  it('links to a shared file directly, on the exact token route, with no mode when it is automatic', () => {
    expect(api.getDirectShareFileUrl('tok123')).toBe(`${origin}/api/share/tok123`);
    expect(api.getDirectShareFileUrl('tok123', '/', 'auto')).toBe(`${origin}/api/share/tok123`);
  });

  it('encodes the token and every segment of the inner path', () => {
    expect(api.getDirectShareFileUrl('to k&1', '/Q3 & Q4/#notes 100%.md/')).toBe(
      `${origin}/api/share/to%20k%261/file/Q3%20%26%20Q4/%23notes%20100%25.md`
    );
  });

  it('adds the chosen mode, whatever its case, and falls back to automatic for one it does not know', () => {
    expect(api.getDirectShareFileUrl('tok123', 'a b.txt', 'download')).toBe(
      `${origin}/api/share/tok123/file/a%20b.txt?mode=download`
    );
    expect(api.getDirectShareFileUrl('tok123', '', 'RAW')).toBe(
      `${origin}/api/share/tok123?mode=raw`
    );
    expect(api.getDirectShareFileUrl('tok123', '', 'Inline')).toBe(
      `${origin}/api/share/tok123?mode=inline`
    );
    expect(api.getDirectShareFileUrl('tok123', 'a.txt', 'exec')).toBe(
      `${origin}/api/share/tok123/file/a.txt`
    );
    expect(api.getDirectShareFileUrl('tok123', 'a.txt', 42)).toBe(
      `${origin}/api/share/tok123/file/a.txt`
    );
  });

  it('opens the editor page rather than the file when the editor mode is chosen', () => {
    expect(api.getDirectShareFileUrl('to k&1', '/Q3 & Q4/#notes.md', 'editor')).toBe(
      `${origin}/editor/share/to%20k%261/Q3%20%26%20Q4/%23notes.md`
    );
    expect(api.getDirectShareFileUrl('tok123', '', 'Editor')).toBe(`${origin}/editor/share/tok123`);
  });
});

describe('copying a link', () => {
  afterEach(() => {
    delete window.navigator.clipboard;
    delete document.execCommand;
  });

  it('copies the direct link it would build, and says it did', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await expect(api.copyDirectShareFileUrl('tok123', 'Q3 & Q4/a.txt', 'download')).resolves.toBe(
      true
    );

    expect(writeText).toHaveBeenCalledWith(
      `${origin}/api/share/tok123/file/Q3%20%26%20Q4/a.txt?mode=download`
    );
  });

  it('lets a refused clipboard fail the copy rather than claiming it worked', async () => {
    const refused = new Error('Document is not focused');
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(refused)) },
      configurable: true,
    });
    document.execCommand = vi.fn(() => true);

    await expect(api.copyShareUrl('tok123')).rejects.toBe(refused);
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('falls back to a hidden text field without the clipboard API, and cleans it up', async () => {
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
    let copiedValue = null;
    document.execCommand = vi.fn((command) => {
      copiedValue = document.activeElement?.value ?? document.querySelector('textarea')?.value;
      return command === 'copy';
    });

    await expect(api.copyDirectShareFileUrl('tok123', 'a b.txt', 'raw')).resolves.toBe(true);

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(copiedValue).toBe(`${origin}/api/share/tok123/file/a%20b.txt?mode=raw`);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports a failed fallback copy as a failure, still cleaning up', async () => {
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = vi.fn(() => false);

    await expect(api.copyShareUrl('tok123')).resolves.toBe(false);

    expect(document.querySelector('textarea')).toBeNull();
  });
});
