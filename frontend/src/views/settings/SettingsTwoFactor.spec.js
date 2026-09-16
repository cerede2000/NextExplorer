import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * Turning a second factor on, and off again.
 *
 * Three steps, each one somebody can stop in the middle of: a secret to scan,
 * a code that proves the phone kept it, and ten codes on paper. What this pins
 * is what each step leaves behind — nothing is on before the code, the paper
 * is shown exactly once, and taking it off asks for the password.
 */

const api = vi.hoisted(() => ({
  fetchTwoFactorStatus: vi.fn(),
  startTwoFactorEnrolment: vi.fn(),
  confirmTwoFactorEnrolment: vi.fn(),
  replaceRecoveryCodes: vi.fn(),
  disableTwoFactor: vi.fn(),
}));

vi.mock('@/api', () => api);

const auth = vi.hoisted(() => ({ store: { currentUser: { provider: 'local' } } }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth.store }));

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key, count) => (typeof count === 'number' ? `${key}:${count}` : key) }),
}));

const SettingsTwoFactor = (await import('./SettingsTwoFactor.vue')).default;

const OFF = { enabled: false, pending: false, recoveryCodesLeft: 0 };
const ON = { enabled: true, pending: false, recoveryCodesLeft: 10 };
const CODES = Array.from({ length: 10 }, (_, index) => `AAAAA-0000${index}`);

/**
 * Wait for the QR generator to arrive.
 *
 * It is loaded on demand, and a module load is not a microtask: flushing
 * promises once returns while the import is still in flight. That is invisible
 * on a machine where the module is already warm and reliably wrong on a cold
 * one, which is where this was first seen.
 */
const untilDrawn = async (wrapper) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (wrapper.findAll('[data-test="two-factor-qr"] rect').length > 0) return;
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const open = async (status = OFF) => {
  api.fetchTwoFactorStatus.mockResolvedValue(status);
  const wrapper = mount(SettingsTwoFactor, {
    global: { mocks: { $t: (key) => key } },
  });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  auth.store.currentUser = { provider: 'local' };
  Object.values(api).forEach((mock) => mock.mockReset());
});

describe('turning it on', () => {
  it('offers to start when it is off', async () => {
    const wrapper = await open();

    expect(wrapper.find('[data-test="two-factor-off"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="two-factor-qr"]').exists()).toBe(false);
  });

  it('shows a square to scan and the secret to type, and turns nothing on yet', async () => {
    const wrapper = await open();
    api.startTwoFactorEnrolment.mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      uri: 'otpauth://totp/NextExplorer:someone?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    });
    api.fetchTwoFactorStatus.mockResolvedValue({ ...OFF, pending: true });

    await wrapper.find('button').trigger('click');
    await flushPromises();
    await untilDrawn(wrapper);

    const square = wrapper.find('[data-test="two-factor-qr"]');
    expect(square.exists()).toBe(true);
    // A real QR code: a few hundred squares rather than a picture of nothing.
    expect(square.findAll('rect').length).toBeGreaterThan(100);
    // Read in groups, which is how it is typed into a phone.
    expect(wrapper.find('[data-test="two-factor-secret"]').text()).toBe(
      'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP'
    );
    expect(wrapper.find('[data-test="two-factor-on"]').exists()).toBe(false);
  });

  it('turns it on with the code, and shows the paper codes once', async () => {
    const wrapper = await open();
    api.startTwoFactorEnrolment.mockResolvedValue({ secret: 'ABCD', uri: 'otpauth://totp/x' });
    await wrapper.find('button').trigger('click');
    await flushPromises();

    api.confirmTwoFactorEnrolment.mockResolvedValue({ recoveryCodes: CODES });
    api.fetchTwoFactorStatus.mockResolvedValue(ON);
    wrapper.find('input').setValue('081804');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.confirmTwoFactorEnrolment).toHaveBeenCalledWith('081804');
    const paper = wrapper.find('[data-test="recovery-codes"]');
    expect(paper.exists()).toBe(true);
    expect(paper.findAll('li')).toHaveLength(10);
    expect(wrapper.find('[data-test="two-factor-on"]').exists()).toBe(true);
    // The secret is gone from the screen the moment it is no longer needed.
    expect(wrapper.find('[data-test="two-factor-secret"]').exists()).toBe(false);
  });

  /**
   * The code was accepted and the status could not be read back. What must not
   * happen then is a screen still offering the secret to scan: it is confirmed,
   * and what matters now is the paper.
   */
  it('lets go of the secret even when the server goes quiet afterwards', async () => {
    const wrapper = await open();
    api.startTwoFactorEnrolment.mockResolvedValue({ secret: 'ABCD', uri: 'otpauth://totp/x' });
    await wrapper.find('button').trigger('click');
    await flushPromises();

    api.confirmTwoFactorEnrolment.mockResolvedValue({ recoveryCodes: CODES });
    api.fetchTwoFactorStatus.mockRejectedValue(new Error('offline'));
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('[data-test="two-factor-secret"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="two-factor-qr"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="recovery-codes"]').findAll('li')).toHaveLength(10);
  });

  it('says what went wrong when the code is refused, and stays off', async () => {
    const wrapper = await open();
    api.startTwoFactorEnrolment.mockResolvedValue({ secret: 'ABCD', uri: 'otpauth://totp/x' });
    await wrapper.find('button').trigger('click');
    await flushPromises();

    api.confirmTwoFactorEnrolment.mockRejectedValue(new Error('That code is not right.'));
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('[data-test="two-factor-error"]').text()).toBe('That code is not right.');
    expect(wrapper.find('[data-test="recovery-codes"]').exists()).toBe(false);
  });
});

describe('once it is on', () => {
  it('says how many recovery codes are left', async () => {
    const wrapper = await open({ ...ON, recoveryCodesLeft: 7 });

    expect(wrapper.find('[data-test="codes-left"]').text()).toBe('settings.twoFactor.codesLeft:7');
  });

  it('asks for the password to draw new codes, and shows them', async () => {
    const wrapper = await open(ON);
    api.replaceRecoveryCodes.mockResolvedValue({ recoveryCodes: CODES });

    wrapper.find('input[type="password"]').setValue('secret123');
    await wrapper.find('[data-test="draw-new-codes"]').trigger('click');
    await flushPromises();

    expect(api.replaceRecoveryCodes).toHaveBeenCalledWith('secret123');
    expect(wrapper.find('[data-test="recovery-codes"]').findAll('li')).toHaveLength(10);
  });

  it('asks for the password to take it off', async () => {
    const wrapper = await open(ON);
    api.disableTwoFactor.mockResolvedValue(undefined);
    api.fetchTwoFactorStatus.mockResolvedValue(OFF);

    wrapper.find('input[type="password"]').setValue('secret123');
    await wrapper.find('[data-test="turn-off"]').trigger('click');
    await flushPromises();

    expect(api.disableTwoFactor).toHaveBeenCalledWith('secret123');
    expect(wrapper.find('[data-test="two-factor-off"]').exists()).toBe(true);
  });

  it('keeps it on when the password is refused, and says so in its own words', async () => {
    const wrapper = await open(ON);
    const refusal = new Error('That password is not right.');
    refusal.code = 'AUTH_PASSWORD_INCORRECT';
    api.disableTwoFactor.mockRejectedValue(refusal);

    await wrapper.find('[data-test="turn-off"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="two-factor-error"]').text()).toBe(
      'settings.twoFactor.wrongPassword'
    );
    expect(wrapper.find('[data-test="two-factor-on"]').exists()).toBe(true);
  });
});

/** With a provider, the second factor is the provider's to ask for. */
describe('an account that signs in elsewhere', () => {
  it('says so, and asks the server nothing', async () => {
    auth.store.currentUser = { provider: 'oidc' };

    const wrapper = await open();

    expect(api.fetchTwoFactorStatus).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('settings.twoFactor.notLocalUser');
    expect(wrapper.find('[data-test="two-factor-off"]').exists()).toBe(false);
  });
});
