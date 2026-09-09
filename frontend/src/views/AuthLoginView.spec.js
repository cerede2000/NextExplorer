import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * The front door.
 *
 * 104 statements at 8.79%, and every one of them is either letting somebody in
 * or refusing them. Two decisions here are the kind that are only noticed once
 * they are wrong: a screen that redirects an already-signed-in visitor rather
 * than asking again, and the sign-out flag that stops an OIDC deployment
 * signing you straight back in — without it, logging out is a page flicker and
 * you are back where you started, permanently unable to leave.
 */

const auth = vi.hoisted(() => ({ store: null }));
const login = vi.hoisted(() => vi.fn(async () => {}));
const ensureStatus = vi.hoisted(() => vi.fn(async () => {}));
const clearError = vi.hoisted(() => vi.fn());

vi.mock('@/stores/auth', async () => {
  const { reactive } = await import('vue');
  auth.store = reactive({
    hasStatus: true,
    isLoading: false,
    isAuthenticated: false,
    requiresSetup: false,
    lastError: '',
    strategies: { local: true, oidc: false },
    login,
    ensureStatus,
    clearError,
  });
  return { useAuthStore: () => auth.store };
});

const features = vi.hoisted(() => ({
  version: '3.3.0',
  demoLogin: null,
  ensureLoaded: vi.fn(async () => {}),
}));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => ({ ensureLoaded: vi.fn() }) }));

vi.mock('@/api', () => ({ apiBase: '' }));

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));

const routing = vi.hoisted(() => ({ route: null, updateGuards: [] }));
const replace = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  routing.route = reactive({ query: {}, path: '/login' });
  return {
    useRoute: () => routing.route,
    useRouter: () => ({ replace, push }),
    onBeforeRouteUpdate: (guard) => routing.updateGuards.push(guard),
    RouterLink: { template: '<a><slot /></a>' },
  };
});

vi.mock('@/layouts/AuthLayout.vue', () => ({
  default: { name: 'AuthLayoutStub', template: '<div><slot name="heading" /><slot /></div>' },
}));

const AuthLoginView = (await import('./AuthLoginView.vue')).default;

let wrapper = null;
let navigatedTo = '';

const mountLogin = async () => {
  wrapper = mount(AuthLoginView, { global: { mocks: { $t: (key) => key } } });
  await flushPromises();
  return wrapper.vm;
};

const signIn = async (view, identifier = 'moi@example.com', password = 'secret') => {
  view.loginIdentifier = identifier;
  view.loginPasswordValue = password;
  await view.handleLoginSubmit();
  await flushPromises();
};

beforeEach(() => {
  navigatedTo = '';
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return navigatedTo;
      },
      set href(value) {
        navigatedTo = value;
      },
    },
  });
  window.sessionStorage.clear();
  routing.updateGuards.length = 0;
  if (routing.route) Object.assign(routing.route, { query: {}, path: '/login' });
  if (auth.store) {
    Object.assign(auth.store, {
      hasStatus: true,
      isLoading: false,
      isAuthenticated: false,
      requiresSetup: false,
      lastError: '',
      strategies: { local: true, oidc: false },
    });
  }
  features.demoLogin = null;
  [login, ensureStatus, clearError, replace, push, features.ensureLoaded].forEach((m) =>
    m.mockClear()
  );
  login.mockResolvedValue(undefined);
  ensureStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('arriving at the sign-in screen', () => {
  it('asks the server who is signed in, when it does not already know', async () => {
    auth.store.hasStatus = false;

    await mountLogin();

    expect(ensureStatus).toHaveBeenCalled();
  });

  it('does not ask again when it already knows', async () => {
    await mountLogin();

    expect(ensureStatus).not.toHaveBeenCalled();
  });

  /** Somebody already signed in has no business being asked again. */
  it('sends an already-signed-in visitor on their way', async () => {
    auth.store.isAuthenticated = true;

    await mountLogin();

    expect(replace).toHaveBeenCalledWith('/browse/');
  });

  it('sends them where they were trying to go', async () => {
    auth.store.isAuthenticated = true;
    routing.route.query = { redirect: '/browse/Docs/rapport' };

    await mountLogin();

    expect(replace).toHaveBeenCalledWith('/browse/Docs/rapport');
  });

  /** A server with no account yet needs one made, not a password typed. */
  it('sends a fresh install to the setup screen, keeping where they were headed', async () => {
    auth.store.requiresSetup = true;
    routing.route.query = { redirect: '/browse/Docs' };

    await mountLogin();

    expect(replace).toHaveBeenCalledWith({
      name: 'auth-setup',
      query: { redirect: '/browse/Docs' },
    });
  });

  it('knows this screen is here because a session ran out', async () => {
    routing.route.query = { reason: 'expired' };

    const view = await mountLogin();

    expect(view.sessionExpired).toBe(true);
  });

  it('does not say that when somebody simply came to sign in', async () => {
    const view = await mountLogin();

    expect(view.sessionExpired).toBe(false);
  });
});

describe('signing in with an email or a username, and a password', () => {
  it('sends what was typed, without the stray spaces around it', async () => {
    const view = await mountLogin();

    await signIn(view, '  moi@example.com  ');

    expect(login).toHaveBeenCalledWith({ identifier: 'moi@example.com', password: 'secret' });
  });

  it('goes where the visitor was headed', async () => {
    routing.route.query = { redirect: '/browse/Docs' };
    const view = await mountLogin();

    await signIn(view);

    expect(replace).toHaveBeenCalledWith('/browse/Docs');
  });

  /** A password left in a form is a password on the screen of an unlocked laptop. */
  it('empties the form behind it', async () => {
    const view = await mountLogin();

    await signIn(view);

    expect(view.loginIdentifier).toBe('');
    expect(view.loginPasswordValue).toBe('');
  });

  it('sends a username the same way it sends an address', async () => {
    const view = await mountLogin();

    await signIn(view, 'alice');

    expect(login).toHaveBeenCalledWith({ identifier: 'alice', password: 'secret' });
  });

  it('asks for one of the two before sending anything', async () => {
    const view = await mountLogin();

    await signIn(view, '   ');

    expect(login).not.toHaveBeenCalled();
    expect(view.loginError).toBe('errors.identifierRequired');
  });

  it('asks for a password too', async () => {
    const view = await mountLogin();

    await signIn(view, 'moi@example.com', '');

    expect(login).not.toHaveBeenCalled();
    expect(view.loginError).toBe('errors.passwordRequired');
  });

  it('says what the server said when it refused', async () => {
    login.mockRejectedValue(new Error('Invalid email or password'));
    const view = await mountLogin();

    await signIn(view);

    expect(view.loginError).toBe('Invalid email or password');
    expect(replace).not.toHaveBeenCalled();
  });

  /** Otherwise the button stays disabled and there is no second attempt. */
  it('lets a refused attempt be tried again', async () => {
    login.mockRejectedValue(new Error('nope'));
    const view = await mountLogin();

    await signIn(view);

    expect(view.isSubmittingLogin).toBe(false);
  });

  it('keeps what was typed in, so it can be corrected', async () => {
    login.mockRejectedValue(new Error('nope'));
    const view = await mountLogin();

    await signIn(view);

    expect(view.loginIdentifier).toBe('moi@example.com');
  });

  it('refuses outright where the server has switched local sign-in off', async () => {
    auth.store.strategies = { local: false, oidc: true };
    const view = await mountLogin();

    await signIn(view);

    expect(login).not.toHaveBeenCalled();
    expect(view.loginError).toBe('errors.localSignInDisabled');
  });

  it('clears an older complaint before trying again', async () => {
    const view = await mountLogin();
    view.loginError = 'something old';

    await signIn(view);

    expect(view.loginError).toBe('');
    expect(clearError).toHaveBeenCalled();
  });
});

describe('signing in through an identity provider', () => {
  beforeEach(() => {
    auth.store.strategies = { local: true, oidc: true };
  });

  it('goes to the provider, carrying where to come back to', async () => {
    routing.route.query = { redirect: '/browse/Docs' };
    const view = await mountLogin();

    view.handleOidcLogin();

    expect(navigatedTo).toBe('/login?returnTo=%2Fbrowse%2FDocs');
  });

  /**
   * Signing out and being signed straight back in is not signing out. The
   * provider still holds a session, so it has to be told to ask again.
   */
  it('makes the provider ask again after a sign-out', async () => {
    window.sessionStorage.setItem('oidcSignedOut', '1');
    const view = await mountLogin();

    view.handleOidcLogin();

    expect(navigatedTo).toContain('prompt=login');
  });

  it('forgets the sign-out once it has been acted on', async () => {
    window.sessionStorage.setItem('oidcSignedOut', '1');
    const view = await mountLogin();

    view.handleOidcLogin();
    navigatedTo = '';
    view.handleOidcLogin();

    expect(navigatedTo).not.toContain('prompt=login');
    expect(window.sessionStorage.getItem('oidcSignedOut')).toBeNull();
  });

  /** With nothing else on offer, a form nobody can use is a dead end. */
  it('starts on its own where it is the only way in', async () => {
    auth.store.strategies = { local: false, oidc: true };

    await mountLogin();

    expect(navigatedTo).toContain('/login');
  });

  /** Except straight after a sign-out, which would make leaving impossible. */
  it('does not start on its own for somebody who has just signed out', async () => {
    auth.store.strategies = { local: false, oidc: true };
    window.sessionStorage.setItem('oidcSignedOut', '1');

    await mountLogin();

    expect(navigatedTo).toBe('');
  });

  it('does not start on its own where a password would also do', async () => {
    auth.store.strategies = { local: true, oidc: true };

    await mountLogin();

    expect(navigatedTo).toBe('');
  });
});

describe('an error handed back by the identity provider', () => {
  it('is shown, in the words the provider used', async () => {
    routing.route.query = { error_description: 'Account is locked' };

    const view = await mountLogin();

    expect(view.loginError).toBe('Account is locked');
  });

  it('falls back to the bare code when that is all there is', async () => {
    routing.route.query = { error: 'access_denied' };

    const view = await mountLogin();

    expect(view.loginError).toBe('access_denied');
  });

  /**
   * An error left in the address bar is bookmarked, pasted into a chat and
   * shown again on every reload, long after it stopped being true.
   */
  it('is taken out of the address bar once it has been read', async () => {
    routing.route.query = { error: 'access_denied', redirect: '/browse/Docs' };

    await mountLogin();

    expect(replace).toHaveBeenCalledWith({ query: { redirect: '/browse/Docs' } });
  });

  it('leaves the address bar alone when there was no error in it', async () => {
    routing.route.query = { redirect: '/browse/Docs' };

    await mountLogin();

    expect(replace).not.toHaveBeenCalled();
  });

  it('is shown when it arrives on a later navigation too', async () => {
    const view = await mountLogin();

    routing.updateGuards.forEach((guard) => guard({ query: { error: 'invalid_scope' } }));
    await flushPromises();

    expect(view.loginError).toBe('invalid_scope');
  });

  it('does not overwrite a complaint already on screen', async () => {
    const view = await mountLogin();
    view.loginError = 'Invalid email or password';

    routing.updateGuards.forEach((guard) => guard({ query: { error: 'access_denied' } }));
    await flushPromises();

    expect(view.loginError).toBe('Invalid email or password');
  });
});

describe('a public demo', () => {
  beforeEach(() => {
    features.demoLogin = { email: 'demo@example.com', password: 'demo' };
  });

  /** The demo publishes its login anyway; retyping it is friction for nothing. */
  it('fills the form in', async () => {
    const view = await mountLogin();

    expect(view.loginIdentifier).toBe('demo@example.com');
    expect(view.loginPasswordValue).toBe('demo');
  });

  /** Somebody who has started typing has said what they want in the boxes. */
  it('leaves alone a form somebody has already started', async () => {
    let arrive;
    features.ensureLoaded.mockReturnValueOnce(new Promise((resolve) => { arrive = resolve; }));
    const view = await mountLogin();

    view.loginIdentifier = 'moi@example.com';
    view.loginPasswordValue = 'le mien';
    arrive();
    await flushPromises();

    expect(view.loginIdentifier).toBe('moi@example.com');
    expect(view.loginPasswordValue).toBe('le mien');
  });

  it('leaves nothing filled in where there is no demo', async () => {
    features.demoLogin = null;

    const view = await mountLogin();

    expect(view.loginIdentifier).toBe('');
  });

  it('carries on when the server would not say', async () => {
    features.ensureLoaded.mockRejectedValueOnce(new Error('offline'));

    const view = await mountLogin();

    expect(view.loginIdentifier).toBe('');
    expect(view.loginError).toBe('');
  });
});
