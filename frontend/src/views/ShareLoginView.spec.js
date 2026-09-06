import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * The other door: a shared link.
 *
 * 92 statements at 18.60%, and one of them is a security rule that looks like a
 * formatting check. The screen sends the visitor to `?redirect=...` after
 * letting them in, and a value beginning with `//` is not a path — it is
 * another site. Without the guard, a link to our own share screen carries
 * somebody to `//evil.example` and the address they trusted was ours.
 *
 * Around it: who is asked for a password and who is not, and the three ways a
 * link opens itself without anybody typing anything.
 */

const api = vi.hoisted(() => ({
  getShareInfo: vi.fn(),
  verifySharePassword: vi.fn(),
  accessShare: vi.fn(async () => ({})),
  setGuestSession: vi.fn(),
}));

vi.mock('@/api/shares.api', () => ({
  getShareInfo: (...args) => api.getShareInfo(...args),
  verifySharePassword: (...args) => api.verifySharePassword(...args),
  accessShare: (...args) => api.accessShare(...args),
  setGuestSession: (...args) => api.setGuestSession(...args),
}));

vi.mock('@/utils/logger', () => ({
  default: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));

const auth = vi.hoisted(() => ({ store: null }));
const initialize = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/stores/auth', async () => {
  const { reactive } = await import('vue');
  auth.store = reactive({
    hasStatus: true,
    isLoading: false,
    isAuthenticated: false,
    initialize,
  });
  return { useAuthStore: () => auth.store };
});

const routing = vi.hoisted(() => ({ route: null }));
const push = vi.hoisted(() => vi.fn());

vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  routing.route = reactive({
    params: { token: 'tok123' },
    query: {},
    fullPath: '/share/tok123',
  });
  return { useRoute: () => routing.route, useRouter: () => ({ push }) };
});

const ShareLoginView = (await import('./ShareLoginView.vue')).default;

const PUBLIC_SHARE = {
  requiresPassword: false,
  sharingType: 'anyone',
  isExpired: false,
  name: 'Docs',
  isDirectory: true,
};

let wrapper = null;
let assigned = '';

const mountShare = async () => {
  wrapper = mount(ShareLoginView, {
    global: { mocks: { $t: (key) => key }, stubs: { LoadingIcon: true } },
  });
  await flushPromises();
  return wrapper.vm;
};

const openOn = async (info, query = {}) => {
  api.getShareInfo.mockResolvedValue(info);
  Object.assign(routing.route, { query });
  return mountShare();
};

beforeEach(() => {
  assigned = '';
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign: (value) => { assigned = value; } },
  });
  Object.values(api).forEach((fn) => fn.mockClear());
  api.accessShare.mockResolvedValue({});
  push.mockClear();
  initialize.mockClear();
  Object.assign(routing.route, {
    params: { token: 'tok123' },
    query: {},
    fullPath: '/share/tok123',
  });
  Object.assign(auth.store, { hasStatus: true, isLoading: false, isAuthenticated: false });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('where a visitor is sent once they are in', () => {
  /**
   * `//evil.example` is a protocol-relative URL, not a path. Followed, it
   * leaves the site entirely — from a link whose address was ours.
   */
  it('refuses to leave the site for a value that only looks like a path', async () => {
    const view = await openOn(PUBLIC_SHARE, { redirect: '//evil.example/steal' });

    expect(view.redirectTarget).toBeNull();
    expect(assigned).toBe('');
    expect(push).toHaveBeenCalledWith({
      name: 'FolderView',
      params: { path: 'share/tok123' },
    });
  });

  it('refuses an address somewhere else outright', async () => {
    const view = await openOn(PUBLIC_SHARE, { redirect: 'https://evil.example' });

    expect(view.redirectTarget).toBeNull();
  });

  it('refuses a value that is not a string at all', async () => {
    const view = await openOn(PUBLIC_SHARE, { redirect: { toString: () => '/browse' } });

    expect(view.redirectTarget).toBeNull();
  });

  it('follows a path inside the site', async () => {
    await openOn(PUBLIC_SHARE, { redirect: '/browse/share/tok123/Docs' });

    expect(assigned).toBe('/browse/share/tok123/Docs');
  });

  it('takes the first of several, rather than the list', async () => {
    const view = await openOn(PUBLIC_SHARE, { redirect: ['/browse/a', '/browse/b'] });

    expect(view.redirectTarget).toBe('/browse/a');
  });

  it('goes to the share itself when nothing else was asked for', async () => {
    await openOn(PUBLIC_SHARE);

    expect(push).toHaveBeenCalledWith({
      name: 'FolderView',
      params: { path: 'share/tok123' },
    });
  });
});

describe('a link anyone may open', () => {
  it('opens itself, without asking anything', async () => {
    await openOn(PUBLIC_SHARE);

    expect(api.accessShare).toHaveBeenCalledWith('tok123');
    expect(push).toHaveBeenCalled();
  });

  /** The guest session is what the rest of the visit is carried by. */
  it('keeps the guest session the server handed back', async () => {
    api.accessShare.mockResolvedValue({ guestSessionId: 'guest-9' });

    await openOn(PUBLIC_SHARE);

    expect(api.setGuestSession).toHaveBeenCalledWith('guest-9', 'tok123');
  });

  it('says nothing about a session the server did not give', async () => {
    await openOn(PUBLIC_SHARE);

    expect(api.setGuestSession).not.toHaveBeenCalled();
  });

  it('does not open an expired one', async () => {
    await openOn({ ...PUBLIC_SHARE, isExpired: true });

    expect(api.accessShare).not.toHaveBeenCalled();
  });

  it('does not open one that wants a password', async () => {
    await openOn({ ...PUBLIC_SHARE, requiresPassword: true });

    expect(api.accessShare).not.toHaveBeenCalled();
  });

  it('says why it could not be opened', async () => {
    api.accessShare.mockRejectedValue(new Error('Share was revoked'));

    const view = await openOn(PUBLIC_SHARE);

    expect(view.error).toBe('Share was revoked');
  });

  it('says why the link could not be read at all', async () => {
    api.getShareInfo.mockRejectedValue(new Error('Share not found'));

    const view = await mountShare();

    expect(view.error).toBe('Share not found');
    expect(view.loading).toBe(false);
  });
});

describe('a link named to particular people', () => {
  const NAMED = { ...PUBLIC_SHARE, sharingType: 'users' };

  it('opens itself for somebody already signed in', async () => {
    auth.store.isAuthenticated = true;

    await openOn(NAMED);

    expect(api.accessShare).toHaveBeenCalledWith('tok123');
    expect(push).toHaveBeenCalled();
  });

  it('finds out who is signed in before deciding', async () => {
    auth.store.hasStatus = false;

    await openOn(NAMED);

    expect(initialize).toHaveBeenCalled();
  });

  it('opens nothing for a stranger', async () => {
    await openOn(NAMED);

    expect(api.accessShare).not.toHaveBeenCalled();
  });

  it('opens nothing once it has expired, signed in or not', async () => {
    auth.store.isAuthenticated = true;

    await openOn({ ...NAMED, isExpired: true });

    expect(api.accessShare).not.toHaveBeenCalled();
  });

  it('says why it was refused', async () => {
    auth.store.isAuthenticated = true;
    api.accessShare.mockRejectedValue(new Error('You are not on this share'));

    const view = await openOn(NAMED);

    expect(view.error).toBe('You are not on this share');
  });

  /**
   * The password on a named share belongs to the person, not to the link: the
   * owner of a protected link is not asked for their own password.
   */
  it('is never the screen that asks for a password', async () => {
    const view = await openOn({ ...NAMED, requiresPassword: true });

    expect(view.requiresPassword).toBe(false);
  });
});

describe('a link with a password on it', () => {
  const LOCKED = { ...PUBLIC_SHARE, requiresPassword: true };

  it('asks for one', async () => {
    const view = await openOn(LOCKED);

    expect(view.requiresPassword).toBe(true);
    expect(view.loading).toBe(false);
  });

  it('opens the share once the password is accepted', async () => {
    api.verifySharePassword.mockResolvedValue({ success: true });
    const view = await openOn(LOCKED);
    view.password = 'hunter2';

    await view.handlePasswordSubmit();
    await flushPromises();

    expect(api.verifySharePassword).toHaveBeenCalledWith('tok123', 'hunter2');
    expect(push).toHaveBeenCalled();
  });

  it('keeps the guest session that came with it', async () => {
    api.verifySharePassword.mockResolvedValue({ success: true, guestSessionId: 'guest-4' });
    const view = await openOn(LOCKED);
    view.password = 'hunter2';

    await view.handlePasswordSubmit();

    expect(api.setGuestSession).toHaveBeenCalledWith('guest-4', 'tok123');
  });

  it('asks for a password before sending anything', async () => {
    const view = await openOn(LOCKED);

    await view.handlePasswordSubmit();

    expect(api.verifySharePassword).not.toHaveBeenCalled();
    expect(view.verificationError).toBe('errors.pleaseEnterPassword');
  });

  it('says the password was wrong', async () => {
    api.verifySharePassword.mockRejectedValue(new Error('Incorrect password'));
    const view = await openOn(LOCKED);
    view.password = 'nope';

    await view.handlePasswordSubmit();

    expect(view.verificationError).toBe('Incorrect password');
    expect(push).not.toHaveBeenCalled();
  });

  it('lets a wrong password be tried again', async () => {
    api.verifySharePassword.mockRejectedValue(new Error('Incorrect password'));
    const view = await openOn(LOCKED);
    view.password = 'nope';

    await view.handlePasswordSubmit();

    expect(view.isVerifying).toBe(false);
  });

  /**
   * A password can be right and still not be enough: the share is named to
   * people, so the visitor has to say who they are.
   */
  it('sends the visitor to sign in when the password alone will not do', async () => {
    api.verifySharePassword.mockResolvedValue({ success: false, requiresAuth: true });
    const view = await openOn(LOCKED);
    view.password = 'hunter2';

    await view.handlePasswordSubmit();

    expect(push).toHaveBeenCalledWith({
      name: 'auth-login',
      query: { redirect: '/share/tok123' },
    });
  });

  it('clears an older complaint before trying again', async () => {
    api.verifySharePassword.mockResolvedValue({ success: true });
    const view = await openOn(LOCKED);
    view.verificationError = 'Incorrect password';
    view.password = 'hunter2';

    await view.handlePasswordSubmit();

    expect(view.verificationError).toBe('');
  });
});

describe('what it says about the share itself', () => {
  it('reads back when it expires', async () => {
    const when = new Date(Date.now() + 86400000).toISOString();

    const view = await openOn({ ...PUBLIC_SHARE, requiresPassword: true, expiresAt: when });

    expect(view.expiryDate?.toISOString()).toBe(when);
  });

  it('says nothing about an expiry a share does not have', async () => {
    const view = await openOn({ ...PUBLIC_SHARE, requiresPassword: true });

    expect(view.expiryDate).toBeNull();
  });

  it('knows an expired share when it sees one', async () => {
    const view = await openOn({ ...PUBLIC_SHARE, isExpired: true });

    expect(view.isExpired).toBe(true);
  });
});
