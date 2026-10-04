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
const submitTotpCode = vi.hoisted(() => vi.fn(async () => ({})));
const cancelTotp = vi.hoisted(() => vi.fn());
const ensureStatus = vi.hoisted(() => vi.fn(async () => {}));
const initialize = vi.hoisted(() => vi.fn(async () => {}));
const clearError = vi.hoisted(() => vi.fn());
const signInWithPasskey = vi.hoisted(() => vi.fn(async () => ({})));
const passkeysSupported = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/stores/auth', async () => {
  const { reactive } = await import('vue');
  auth.store = reactive({
    hasStatus: true,
    isLoading: false,
    isAuthenticated: false,
    requiresSetup: false,
    lastError: '',
    strategies: { local: true, oidc: false, passkey: false },
    oidcStatus: 'ready',
    statusUnavailable: false,
    providerHasNoAccountHere: false,
    initialize,
    login,
    signInWithPasskey,
    submitTotpCode,
    cancelTotp,
    totpPending: false,
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

vi.mock('@/api', () => ({ apiBase: '', passkeysSupported }));

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

const { forgetHandedOff } = await import('@/utils/providerHandoff');
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
      strategies: { local: true, oidc: false, passkey: false },
      oidcStatus: 'ready',
      statusUnavailable: false,
      providerHasNoAccountHere: false,
      totpPending: false,
    });
  }
  features.demoLogin = null;
  [
    login,
    signInWithPasskey,
    submitTotpCode,
    cancelTotp,
    ensureStatus,
    initialize,
    clearError,
    replace,
    push,
    features.ensureLoaded,
  ].forEach((m) => m.mockClear());
  login.mockResolvedValue(undefined);
  signInWithPasskey.mockResolvedValue({});
  passkeysSupported.mockReturnValue(true);
  ensureStatus.mockResolvedValue(undefined);
  initialize.mockResolvedValue(undefined);
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

  /**
   * Our own route, not the provider library's `/login`: that one exists only
   * where a provider was mounted, so on the installation that most needs
   * telling — nothing configured, or configured and failing — the button led
   * nowhere at all.
   */
  it('goes to the provider through our own route, carrying where to come back to', async () => {
    routing.route.query = { redirect: '/browse/Docs' };
    const view = await mountLogin();

    view.handleOidcLogin();

    expect(navigatedTo).toBe('/api/auth/oidc/login?redirect=%2Fbrowse%2FDocs');
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

    expect(navigatedTo).toContain('/api/auth/oidc/login');
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

/**
 * A sign-in that never reached the provider.
 *
 * There are two reasons and they call for opposite actions: fill the settings
 * in, or go and look at the provider. Both used to arrive as "OIDC is not
 * configured", which sent an administrator whose provider was merely down to
 * change a configuration that was already right. The server names which it was;
 * this screen is where it is said, and it says it in the reader's language.
 */
describe('a sign-in that could not be started', () => {
  it('says the configuration is missing when that is what the server said', async () => {
    routing.route.query = { error_code: 'AUTH_OIDC_NOT_CONFIGURED', error: 'ignored' };

    const view = await mountLogin();

    expect(view.loginError).toBe('errors.oidcNotConfigured');
  });

  it('says the opposite thing when the configuration is there and failed', async () => {
    routing.route.query = { error_code: 'AUTH_OIDC_PROVIDER_UNAVAILABLE', error: 'ignored' };

    const view = await mountLogin();

    expect(view.loginError).toBe('errors.oidcProviderUnavailable');
  });

  /** Every other code is the provider's own, and its sentence is the better one. */
  it('keeps the words that came with a code it does not know', async () => {
    routing.route.query = {
      error_code: 'AUTH_REQUIRED',
      error_description: 'Email must be verified before linking an existing account.',
    };

    const view = await mountLogin();

    expect(view.loginError).toBe('Email must be verified before linking an existing account.');
  });

  /**
   * An error left in the address bar is shown again on every reload, long after
   * it stopped being true — the code no less than the words.
   */
  it('takes the code out of the address bar once it has been read', async () => {
    routing.route.query = { error_code: 'AUTH_OIDC_NOT_CONFIGURED', redirect: '/browse/Docs' };

    await mountLogin();

    expect(replace).toHaveBeenCalledWith({ query: { redirect: '/browse/Docs' } });
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
    features.ensureLoaded.mockReturnValueOnce(
      new Promise((resolve) => {
        arrive = resolve;
      })
    );
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

/**
 * The single sign-on button, before it is pressed.
 *
 * A provider that cannot be reached, or settings nobody filled in, used to be
 * discovered by pressing it: the browser left, and came back to this screen
 * with the answer. The server knows at load — its configuration pass either
 * mounted the hand-off or recorded why it could not — and the screen now says
 * the same two things without the journey.
 */
describe('the single sign-on button', () => {
  const ssoButton = () =>
    wrapper.findAll('button').find((button) => button.text().includes('auth.sso.continue'));

  it.each([
    ['not-configured', 'errors.oidcNotConfigured'],
    ['unavailable', 'errors.oidcProviderUnavailable'],
  ])('is refused, and says why, when the server reports %s', async (status, message) => {
    auth.store.strategies = { local: true, oidc: true };
    auth.store.oidcStatus = status;
    await mountLogin();

    expect(ssoButton().attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain(message);
  });

  it('is offered, with nothing to say, when the hand-off is mounted', async () => {
    auth.store.strategies = { local: true, oidc: true };
    auth.store.oidcStatus = 'ready';
    await mountLogin();

    expect(ssoButton().attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).not.toContain('errors.oidcNotConfigured');
    expect(wrapper.text()).not.toContain('errors.oidcProviderUnavailable');
  });

  /** A server that says nothing about it is taken at its word, as before. */
  it('is offered when the server reports nothing at all', async () => {
    auth.store.strategies = { local: true, oidc: true };
    auth.store.oidcStatus = undefined;
    await mountLogin();

    expect(ssoButton().attributes('disabled')).toBeUndefined();
  });
});

/**
 * The second step, on the same screen.
 *
 * The rule that matters is the one a redirect would break: a password that was
 * right is not a sign-in, so nothing leaves this screen until the code is
 * answered. The rest is what somebody sees while that is true.
 */
describe('when the account asks for a code', () => {
  it('stays on the screen when the password is only half of it', async () => {
    login.mockResolvedValue({ totpRequired: true });
    const view = await mountLogin();

    await signIn(view);

    expect(replace).not.toHaveBeenCalled();
  });

  it('asks for the code instead of the password, and not for the provider', async () => {
    auth.store.totpPending = true;
    auth.store.strategies = { local: true, oidc: true };
    const view = await mountLogin();
    await flushPromises();

    expect(wrapper.find('[data-test="totp-step"]').exists()).toBe(true);
    expect(wrapper.find('#login-password').exists()).toBe(false);
    expect(wrapper.find('#login-totp').exists()).toBe(true);
    // A provider button in the middle of a second step is a way out of it.
    expect(wrapper.text()).not.toContain('auth.sso.continue');
    expect(view).toBeTruthy();
  });

  it('hands the code over and goes where the sign-in was headed', async () => {
    auth.store.totpPending = true;
    submitTotpCode.mockResolvedValue({ usedRecoveryCode: false });
    const view = await mountLogin();

    view.totpCodeValue = ' 081804 ';
    await view.handleTotpSubmit();
    await flushPromises();

    expect(submitTotpCode).toHaveBeenCalledWith('081804');
    expect(replace).toHaveBeenCalled();
  });

  /**
   * The refusal this screen causes on purpose, said in the reader's language.
   * The server's own sentence is English wherever it is written; a code the
   * screen recognises is a sentence out of the catalogue instead.
   */
  it('says a wrong code in its own words, and stays put', async () => {
    auth.store.totpPending = true;
    const refusal = new Error('That code is not right.');
    refusal.code = 'AUTH_INVALID_TOTP_CODE';
    submitTotpCode.mockRejectedValue(refusal);
    const view = await mountLogin();

    view.totpCodeValue = '000000';
    await view.handleTotpSubmit();
    await flushPromises();

    expect(replace).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('errors.totpCodeWrong');
  });

  it('falls back to what the server said when it recognises nothing', async () => {
    auth.store.totpPending = true;
    submitTotpCode.mockRejectedValue(new Error('The server is having a lie down.'));
    const view = await mountLogin();

    view.totpCodeValue = '000000';
    await view.handleTotpSubmit();
    await flushPromises();

    expect(wrapper.text()).toContain('The server is having a lie down.');
  });

  it('asks for nothing when the box is empty', async () => {
    auth.store.totpPending = true;
    const view = await mountLogin();

    view.totpCodeValue = '   ';
    await view.handleTotpSubmit();

    expect(submitTotpCode).not.toHaveBeenCalled();
  });

  it('goes back to the password for somebody who cannot find their phone', async () => {
    auth.store.totpPending = true;
    const view = await mountLogin();

    await wrapper.find('[data-test="totp-cancel"]').trigger('click');

    expect(cancelTotp).toHaveBeenCalled();
    expect(view.totpCodeValue).toBe('');
  });
});

/**
 * The passkey button.
 *
 * Two answers have to agree before it is on screen — the server offers local
 * accounts, and this browser can actually do it. A button that opens a dialog
 * and then fails teaches people the feature is broken.
 */
describe('signing in with a passkey', () => {
  it('is offered when the server and the browser both allow it', async () => {
    auth.store.strategies = { local: true, oidc: false, passkey: true };

    await mountLogin();

    expect(wrapper.find('[data-test="passkey-sign-in"]').exists()).toBe(true);
  });

  it('is not offered when the server does not have it on', async () => {
    auth.store.strategies = { local: true, oidc: false, passkey: false };

    await mountLogin();

    expect(wrapper.find('[data-test="passkey-sign-in"]').exists()).toBe(false);
  });

  it('is not offered where the browser cannot do it', async () => {
    auth.store.strategies = { local: true, oidc: false, passkey: true };
    passkeysSupported.mockReturnValue(false);

    await mountLogin();

    expect(wrapper.find('[data-test="passkey-sign-in"]').exists()).toBe(false);
  });

  it('signs in and goes where the visitor was heading', async () => {
    auth.store.strategies = { local: true, oidc: false, passkey: true };
    signInWithPasskey.mockResolvedValue({ totpRequired: false });
    await mountLogin();

    await wrapper.find('[data-test="passkey-sign-in"]').trigger('click');
    await flushPromises();

    expect(signInWithPasskey).toHaveBeenCalled();
    expect(replace).toHaveBeenCalled();
  });

  it('stays put when the account also wants a code', async () => {
    auth.store.strategies = { local: true, oidc: false, passkey: true };
    signInWithPasskey.mockResolvedValue({ totpRequired: true });
    await mountLogin();

    await wrapper.find('[data-test="passkey-sign-in"]').trigger('click');
    await flushPromises();

    expect(replace).not.toHaveBeenCalled();
  });

  it('says nothing when somebody changes their mind', async () => {
    auth.store.strategies = { local: true, oidc: false, passkey: true };
    const refusal = new Error('not allowed');
    refusal.name = 'NotAllowedError';
    signInWithPasskey.mockRejectedValue(refusal);
    await mountLogin();

    await wrapper.find('[data-test="passkey-sign-in"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).not.toContain('not allowed');
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows a refusal that is not somebody changing their mind', async () => {
    auth.store.strategies = { local: true, oidc: false, passkey: true };
    signInWithPasskey.mockRejectedValue(new Error('That passkey did not open anything here.'));
    await mountLogin();

    await wrapper.find('[data-test="passkey-sign-in"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('That passkey did not open anything here.');
  });
});

/**
 * What this screen offers when the server has not said what it offers.
 *
 * Everything above is the server's answer. The defaults the store falls back
 * to before it has one happen to describe a password sign-in, so a status
 * request that got nowhere — which is what an expired session behind an
 * authentication proxy looks like from a browser — drew a username and a
 * password field on an installation that has neither, under an error about
 * CORS and PUBLIC_URL. Nobody could sign in from that screen, and nothing on
 * it said why.
 */
describe('a server that could not be asked how anybody signs in', () => {
  beforeEach(() => {
    auth.store.statusUnavailable = true;
  });

  it('offers no password form it has no reason to believe in', async () => {
    const view = await mountLogin();

    expect(view.supportsLocal).toBe(false);
    expect(wrapper.find('#login-identifier').exists()).toBe(false);
  });

  it('offers no provider either', async () => {
    auth.store.strategies = { local: false, oidc: true };

    const view = await mountLogin();

    expect(view.supportsOidc).toBe(false);
    expect(navigatedTo).toBe('');
  });

  it('says so, and nothing about CORS', async () => {
    auth.store.lastError = 'Network Error';

    await mountLogin();

    expect(wrapper.find('[data-test="status-unavailable"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Network Error');
  });

  it('asks again when somebody asks it to', async () => {
    const view = await mountLogin();

    await view.handleAskAgain();

    expect(initialize).toHaveBeenCalled();
  });

  /** And once it has an answer, it is an ordinary sign-in screen again. */
  it('draws the form once the server has answered', async () => {
    const view = await mountLogin();
    auth.store.statusUnavailable = false;
    await flushPromises();

    expect(view.supportsLocal).toBe(true);
  });
});

/** An installation with nothing on offer is a heading over an empty box. */
describe('an installation that offers no way in', () => {
  it('says so rather than drawing nothing at all', async () => {
    auth.store.strategies = { local: false, oidc: false, passkey: false };

    await mountLogin();

    expect(wrapper.find('[data-test="no-sign-in-method"]').exists()).toBe(true);
  });

  it('says nothing of the kind while a password would do', async () => {
    await mountLogin();

    expect(wrapper.find('[data-test="no-sign-in-method"]').exists()).toBe(false);
  });
});

/**
 * The circle: the provider signs somebody in, this installation has no session
 * to show for it, and the sign-in screen hands them straight back to the
 * provider, which signs them in again.
 *
 * Nothing in that circle ever reaches a person. The only account of it is a
 * logo spinning for as long as anybody is willing to watch it, so the hand-off
 * is marked on the way out and the screen the browser comes back to reads it.
 */
describe('a trip to the provider that came back with nothing', () => {
  beforeEach(() => {
    auth.store.strategies = { local: false, oidc: true };
  });

  it('does not hand off again straight away', async () => {
    const view = await mountLogin();
    view.handleOidcLogin();
    navigatedTo = '';
    wrapper.unmount();
    wrapper = null;

    await mountLogin();

    expect(navigatedTo).toBe('');
  });

  it('says what happened instead', async () => {
    const view = await mountLogin();
    view.handleOidcLogin();
    wrapper.unmount();
    wrapper = null;

    await mountLogin();

    expect(wrapper.find('[data-test="provider-left-outside"]').exists()).toBe(true);
  });

  /** One stop, not a screen nobody can ever leave: the button still works. */
  it('still goes when somebody presses the button', async () => {
    const first = await mountLogin();
    first.handleOidcLogin();
    wrapper.unmount();
    wrapper = null;
    const view = await mountLogin();
    navigatedTo = '';

    view.handleOidcLogin();

    expect(navigatedTo).toContain('/api/auth/oidc/login');
  });

  /** A session obtained in between is the proof the trip worked. */
  it('hands off on its own once a session has been obtained', async () => {
    const view = await mountLogin();
    view.handleOidcLogin();
    navigatedTo = '';
    wrapper.unmount();
    wrapper = null;
    // What the store does when the status comes back with a user.
    forgetHandedOff();

    await mountLogin();

    expect(navigatedTo).toContain('/api/auth/oidc/login');
  });
});

/**
 * The provider knows this person and this installation has no account for
 * them — `OIDC_AUTO_CREATE_USERS=false` and nobody made it. No number of
 * further trips to the provider will change that, and the sign-in screen used
 * to make all of them.
 */
describe('somebody the provider vouches for and this server does not know', () => {
  beforeEach(() => {
    auth.store.strategies = { local: false, oidc: true };
    auth.store.providerHasNoAccountHere = true;
  });

  it('stays put', async () => {
    await mountLogin();

    expect(navigatedTo).toBe('');
  });

  it('says it is an account that is missing, not a password', async () => {
    await mountLogin();

    expect(wrapper.find('[data-test="provider-left-outside"]').text()).toBe(
      'auth.login.noAccountHere'
    );
  });
});

/**
 * A provider the server already said cannot be reached.
 *
 * The button is disabled for exactly that reason. The automatic hand-off read
 * none of it and went anyway — onto `/api/auth/oidc/login`, which answers a
 * refusal in JSON: a page of JSON in place of the application, with nothing on
 * it to press.
 */
describe('a provider the server says is not there', () => {
  beforeEach(() => {
    auth.store.strategies = { local: false, oidc: true };
  });

  it('is not handed off to on our own account', async () => {
    auth.store.oidcStatus = 'not-configured';

    await mountLogin();

    expect(navigatedTo).toBe('');
  });

  it('is not handed off to by the button either', async () => {
    auth.store.oidcStatus = 'unavailable';
    const view = await mountLogin();

    view.handleOidcLogin();

    expect(navigatedTo).toBe('');
  });

  /** And an error the provider handed back is a reason to stop, once. */
  it('is not handed off to again after it handed back an error', async () => {
    routing.route.query = { error_code: 'AUTH_OIDC_PROVIDER_UNAVAILABLE' };

    await mountLogin();

    expect(navigatedTo).toBe('');
  });
});
