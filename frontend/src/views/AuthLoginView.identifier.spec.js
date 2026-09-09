import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * The one box on the sign-in screen.
 *
 * Issue #5 asked to sign in with a username rather than an email address. The
 * box that used to refuse one was not the server: `type="email"` meant the
 * browser rejected a bare name before anything was ever sent, so the field
 * itself had to stop claiming to be an address.
 */

const auth = vi.hoisted(() => ({ store: null }));
const login = vi.hoisted(() => vi.fn(async () => {}));

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
    ensureStatus: vi.fn(async () => {}),
    clearError: vi.fn(),
  });
  return { useAuthStore: () => auth.store };
});

vi.mock('@/stores/features', () => ({
  useFeaturesStore: () => ({ version: '3.4.0', demoLogin: null, ensureLoaded: vi.fn(async () => {}) }),
}));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => ({ ensureLoaded: vi.fn() }) }));
vi.mock('@/api', () => ({ apiBase: '' }));

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));

vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  const route = reactive({ query: {}, path: '/login' });
  return {
    useRoute: () => route,
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    onBeforeRouteUpdate: () => {},
  };
});

vi.mock('@/layouts/AuthLayout.vue', () => ({
  default: { name: 'AuthLayoutStub', template: '<div><slot name="heading" /><slot /></div>' },
}));

const AuthLoginView = (await import('./AuthLoginView.vue')).default;

let wrapper = null;

const mountLogin = async () => {
  wrapper = mount(AuthLoginView, {
    global: { mocks: { $t: (key) => key } },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper.vm;
};

const field = () => document.querySelector('#login-identifier');

beforeEach(() => {
  login.mockClear();
  login.mockResolvedValue(undefined);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('the box someone types their name into', () => {
  /** `type="email"` is the browser refusing a username before we ever see it. */
  it('does not claim to hold an address', async () => {
    await mountLogin();

    expect(field().getAttribute('type')).toBe('text');
  });

  it('offers the saved username rather than the saved address', async () => {
    await mountLogin();

    expect(field().getAttribute('autocomplete')).toBe('username');
  });

  it('sends a username as it was typed', async () => {
    const view = await mountLogin();
    view.loginIdentifier = 'alice';
    view.loginPasswordValue = 'motdepasse';

    await view.handleLoginSubmit();

    expect(login).toHaveBeenCalledWith({ identifier: 'alice', password: 'motdepasse' });
  });

  it('sends an address the same way', async () => {
    const view = await mountLogin();
    view.loginIdentifier = 'alice@example.com';
    view.loginPasswordValue = 'motdepasse';

    await view.handleLoginSubmit();

    expect(login).toHaveBeenCalledWith({
      identifier: 'alice@example.com',
      password: 'motdepasse',
    });
  });

  it('trims what was typed around it', async () => {
    const view = await mountLogin();
    view.loginIdentifier = '  alice  ';
    view.loginPasswordValue = 'motdepasse';

    await view.handleLoginSubmit();

    expect(login.mock.calls[0][0].identifier).toBe('alice');
  });

  it('asks for one before sending anything', async () => {
    const view = await mountLogin();
    view.loginIdentifier = '   ';
    view.loginPasswordValue = 'motdepasse';

    await view.handleLoginSubmit();

    expect(login).not.toHaveBeenCalled();
    expect(view.loginError).toBe('errors.identifierRequired');
  });
});
