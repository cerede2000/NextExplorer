import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { h, reactive } from 'vue';

/**
 * The first-run screen, where whoever reaches a fresh install creates the
 * first administrator.
 *
 * The account made here owns the server, so what is sent must be what was
 * typed: the password untouched, the email and username trimmed, a username
 * derived from the email when none was given. A confirmation that does not
 * match is refused before anything leaves the page, since nobody could sign in
 * afterwards. Once setup is done, the screen must not stay usable.
 */

const auth = vi.hoisted(() => ({ store: null }));
const features = vi.hoisted(() => ({ version: '3.0.2', ensureLoaded: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const route = vi.hoisted(() => ({ query: {} }));

vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth.store }));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => route }));
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));
// The layout is decoration around the form; it renders the slots and nothing
// else, so no branding store or language selector is pulled in.
vi.mock('@/layouts/AuthLayout.vue', () => ({
  default: {
    props: ['version', 'isLoading'],
    setup:
      (_, { slots }) =>
      () =>
        h('div', [slots.heading?.(), slots.default?.()]),
  },
}));

const AuthSetupView = (await import('./AuthSetupView.vue')).default;

let wrapper;

const open = async (state = {}) => {
  auth.store = reactive({
    requiresSetup: true,
    hasStatus: true,
    isLoading: false,
    lastError: null,
    initialize: vi.fn(),
    clearError: vi.fn(() => {
      auth.store.lastError = null;
    }),
    setupAccount: vi.fn(async () => {
      auth.store.requiresSetup = false;
    }),
    ...state,
  });
  wrapper = mount(AuthSetupView, { global: { mocks: { $t: (key) => key } } });
  await flushPromises();
  return wrapper;
};

const fill = async ({ email = '', username = '', password = '', confirm = '' }) => {
  await wrapper.get('#setup-email').setValue(email);
  await wrapper.get('#setup-username').setValue(username);
  await wrapper.get('#setup-password').setValue(password);
  await wrapper.get('#setup-password-confirm').setValue(confirm);
};

const submit = async () => {
  await wrapper.get('form').trigger('submit');
  await flushPromises();
};

const errorShown = () => wrapper.find('p.text-red-400');

beforeEach(() => {
  router.replace.mockReset();
  features.ensureLoaded.mockReset();
  features.ensureLoaded.mockResolvedValue();
  route.query = {};
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('creating the first administrator', () => {
  // Spaces around the email are also removed by the email field itself, as a
  // browser's is; the username and the password are the screen's own doing.
  it('sends the email and username trimmed, and the password exactly as typed', async () => {
    await open();

    await fill({
      email: '  admin@example.com ',
      username: ' root ',
      password: ' s3cret pass ',
      confirm: ' s3cret pass ',
    });
    await submit();

    expect(auth.store.setupAccount).toHaveBeenCalledTimes(1);
    expect(auth.store.setupAccount).toHaveBeenCalledWith({
      email: 'admin@example.com',
      username: 'root',
      password: ' s3cret pass ',
    });
  });

  it('names the account after the email when no username was given', async () => {
    await open();

    await fill({
      email: 'jane.doe@example.com',
      username: '   ',
      password: 'secret',
      confirm: 'secret',
    });
    await submit();

    expect(auth.store.setupAccount.mock.calls[0][0].username).toBe('jane.doe');
  });

  it('goes on to the files once the account exists', async () => {
    await open();

    await fill({ email: 'admin@example.com', password: 'secret', confirm: 'secret' });
    await submit();

    expect(router.replace).toHaveBeenCalledWith('/browse/');
    expect(errorShown().exists()).toBe(false);
  });

  it('goes on to where the visitor was headed, when that was given', async () => {
    route.query = { redirect: '/browse/Projects' };
    await open();

    await fill({ email: 'admin@example.com', password: 'secret', confirm: 'secret' });
    await submit();

    expect(router.replace).toHaveBeenLastCalledWith('/browse/Projects');
  });

  it('shows it is working, with the form locked until the server answers', async () => {
    let answer;
    await open({
      setupAccount: vi.fn(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          })
      ),
    });

    await fill({ email: 'admin@example.com', password: 'secret', confirm: 'secret' });
    await submit();

    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('button[type="submit"]').text()).toBe('common.creating');
    expect(wrapper.get('#setup-password').attributes('disabled')).toBeDefined();

    answer();
    await flushPromises();

    expect(router.replace).toHaveBeenCalledWith('/browse/');
  });
});

describe('a setup refused before it is sent', () => {
  it('needs the confirmation to match the password', async () => {
    await open();

    await fill({ email: 'admin@example.com', password: 'secret', confirm: 'Secret' });
    await submit();

    expect(auth.store.setupAccount).not.toHaveBeenCalled();
    expect(errorShown().text()).toBe('errors.passwordMismatch');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('needs a password of at least six characters', async () => {
    await open();

    await fill({ email: 'admin@example.com', password: '12345', confirm: '12345' });
    await submit();

    expect(auth.store.setupAccount).not.toHaveBeenCalled();
    expect(errorShown().text()).toBe('errors.passwordLength');
  });

  it('needs an email address', async () => {
    await open();

    await fill({ email: '   ', password: 'secret', confirm: 'secret' });
    await submit();

    expect(auth.store.setupAccount).not.toHaveBeenCalled();
    expect(errorShown().text()).toBe('errors.emailRequired');
  });
});

describe('a setup the server refuses', () => {
  it('shows its reason, stays on the screen, and keeps what was typed', async () => {
    await open({
      setupAccount: vi.fn(async () => {
        throw new Error('Setup has already been completed');
      }),
    });

    await fill({ email: 'admin@example.com', password: 'secret', confirm: 'secret' });
    await submit();

    expect(auth.store.setupAccount).toHaveBeenCalledTimes(1);
    expect(errorShown().text()).toBe('Setup has already been completed');
    expect(router.replace).not.toHaveBeenCalled();
    expect(wrapper.get('#setup-email').element.value).toBe('admin@example.com');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
  });

  it('says the account could not be created when the refusal carries no reason', async () => {
    await open({
      setupAccount: vi.fn(async () => {
        throw { status: 500 };
      }),
    });

    await fill({ email: 'admin@example.com', password: 'secret', confirm: 'secret' });
    await submit();

    expect(errorShown().text()).toBe('errors.createAccount');
  });
});

describe('the status the screen was opened with', () => {
  it('sends the visitor away when setup has already been done', async () => {
    await open({ requiresSetup: false, hasStatus: true });

    expect(router.replace).toHaveBeenCalledWith('/browse/');
  });

  it('waits for the status before deciding, and asks for it', async () => {
    await open({ requiresSetup: false, hasStatus: false });

    expect(auth.store.initialize).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('shows why the status could not be read, until the next attempt clears it', async () => {
    await open({ lastError: 'Unable to reach the server' });

    expect(errorShown().text()).toBe('Unable to reach the server');

    await fill({ email: 'admin@example.com', password: 'secret', confirm: 'secret' });
    await submit();

    expect(auth.store.clearError).toHaveBeenCalled();
    expect(errorShown().exists()).toBe(false);
  });
});
