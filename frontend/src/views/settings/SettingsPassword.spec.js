import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * The page where a signed-in user changes their own password.
 *
 * It must refuse, before anything is sent, a request that would lock the
 * person out by accident: no current password, a new one too short, or a
 * confirmation that does not match what was typed. What it sends is the
 * current and the new password, never the confirmation. A refusal from the
 * server has to reach the person; so does a success, which empties the form
 * and says the other sessions of the account were signed out — the server ends
 * them, and someone finding another device signed out should know why.
 */

const changePassword = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ store: null }));

vi.mock('@/api', () => ({ changePassword: (...args) => changePassword(...args) }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth.store }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));

import SettingsPassword from './SettingsPassword.vue';

let wrapper;

const open = async (currentUser = { id: 'u1', provider: 'local' }) => {
  auth.store = reactive({ currentUser });
  wrapper = mount(SettingsPassword);
  await flushPromises();
  return wrapper;
};

const fill = async ({ current = '', next = '', confirm = '' }) => {
  await wrapper.get('#current-password').setValue(current);
  await wrapper.get('#new-password').setValue(next);
  await wrapper.get('#confirm-password').setValue(confirm);
};

const submit = async () => {
  await wrapper.get('form').trigger('submit');
  await flushPromises();
};

const error = () => wrapper.find('.bg-red-100');
const success = () => wrapper.find('.bg-green-100');

beforeEach(() => {
  changePassword.mockReset();
  changePassword.mockResolvedValue({ success: true });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('a password change that is valid', () => {
  it('sends the current and the new password, and not the confirmation', async () => {
    await open();

    await fill({ current: 'old-secret', next: 'new-secret', confirm: 'new-secret' });
    await submit();

    expect(changePassword).toHaveBeenCalledTimes(1);
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: 'old-secret',
      newPassword: 'new-secret',
    });
  });

  it('sends passwords exactly as typed, spaces included', async () => {
    await open();

    await fill({ current: ' old ', next: ' new pass ', confirm: ' new pass ' });
    await submit();

    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: ' old ',
      newPassword: ' new pass ',
    });
  });

  it('says it worked, that the other sessions were signed out, and empties every field', async () => {
    await open();

    await fill({ current: 'old-secret', next: 'new-secret', confirm: 'new-secret' });
    await submit();

    expect(success().text()).toBe('settings.password.successOtherSessionsEnded');
    expect(error().exists()).toBe(false);
    expect(wrapper.get('#current-password').element.value).toBe('');
    expect(wrapper.get('#new-password').element.value).toBe('');
    expect(wrapper.get('#confirm-password').element.value).toBe('');
  });

  it('shows it is working, and cannot be pressed again until the server answers', async () => {
    let answer;
    changePassword.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    await open();

    await fill({ current: 'old-secret', next: 'new-secret', confirm: 'new-secret' });
    await submit();

    const button = wrapper.get('button[type="submit"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toBe('common.updating');

    answer({ success: true });
    await flushPromises();

    expect(button.attributes('disabled')).toBeUndefined();
  });
});

describe('a password change refused before it is sent', () => {
  it('needs the current password', async () => {
    await open();

    await fill({ current: '', next: 'new-secret', confirm: 'new-secret' });
    await submit();

    expect(changePassword).not.toHaveBeenCalled();
    expect(error().text()).toBe('errors.pleaseEnterPassword');
  });

  it('needs a new password of at least six characters', async () => {
    await open();

    await fill({ current: 'old-secret', next: '12345', confirm: '12345' });
    await submit();

    expect(changePassword).not.toHaveBeenCalled();
    expect(error().text()).toBe('errors.passwordMin');
  });

  it('accepts a new password of exactly six characters', async () => {
    await open();

    await fill({ current: 'old-secret', next: '123456', confirm: '123456' });
    await submit();

    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  it('needs the confirmation to match the new password', async () => {
    await open();

    await fill({ current: 'old-secret', next: 'new-secret', confirm: 'new-secret!' });
    await submit();

    expect(changePassword).not.toHaveBeenCalled();
    expect(error().text()).toBe('errors.passwordMismatch');
    // What was typed stays, so it can be corrected.
    expect(wrapper.get('#new-password').element.value).toBe('new-secret');
  });

  it('is offered only to an account whose password this server keeps', async () => {
    await open({ id: 'u2', provider: 'oidc' });

    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.text()).toContain('settings.password.notLocalUser');
  });

  it('is not offered with nobody signed in', async () => {
    await open(null);

    expect(wrapper.find('form').exists()).toBe(false);
  });
});

describe('a password change the server refuses', () => {
  it('shows the reason, keeps what was typed, and can be tried again', async () => {
    changePassword.mockRejectedValueOnce(new Error('Current password is incorrect'));
    await open();

    await fill({ current: 'wrong', next: 'new-secret', confirm: 'new-secret' });
    await submit();

    expect(error().text()).toBe('Current password is incorrect');
    expect(success().exists()).toBe(false);
    expect(wrapper.get('#current-password').element.value).toBe('wrong');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();

    await wrapper.get('#current-password').setValue('old-secret');
    await submit();

    expect(changePassword).toHaveBeenCalledTimes(2);
    expect(error().exists()).toBe(false);
    expect(success().exists()).toBe(true);
  });

  it('says the change failed when the refusal carries no reason', async () => {
    changePassword.mockRejectedValue({});
    await open();

    await fill({ current: 'old-secret', next: 'new-secret', confirm: 'new-secret' });
    await submit();

    expect(error().text()).toBe('errors.changePassword');
  });

  it('does not leave an earlier success on screen', async () => {
    await open();
    await fill({ current: 'old-secret', next: 'new-secret', confirm: 'new-secret' });
    await submit();
    expect(success().exists()).toBe(true);

    changePassword.mockRejectedValue(new Error('Current password is incorrect'));
    await fill({ current: 'new-secret', next: 'third-secret', confirm: 'third-secret' });
    await submit();

    expect(success().exists()).toBe(false);
    expect(error().text()).toBe('Current password is incorrect');
  });
});
