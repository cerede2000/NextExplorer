import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * The activity log page.
 *
 * The switch is the feature, so the page has to be honest about it: with the
 * log off the list is empty because nothing was recorded, and saying that is
 * the difference between a setting nobody turned on and a page that looks
 * broken. The rest is a list with filters and a place to carry on from.
 */

const api = vi.hoisted(() => ({
  fetchActivity: vi.fn(),
  clearActivity: vi.fn(),
}));
vi.mock('@/api', () => api);

const store = vi.hoisted(() => ({
  settings: {
    systemSettings: { activity: { enabled: false, retentionDays: 90 } },
    save: vi.fn(async () => ({})),
  },
}));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => store.settings }));

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));

vi.mock('@/components/ToggleSwitch.vue', () => ({
  default: {
    name: 'ToggleSwitch',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<button @click="$emit(\'update:modelValue\', !modelValue)">{{ modelValue }}</button>',
  },
}));

const SettingsActivity = (await import('./SettingsActivity.vue')).default;

const EVENTS = [
  {
    id: 'e1',
    at: '2026-09-17T09:00:00.000Z',
    action: 'sign-in',
    outcome: 'ok',
    actor: 'ada',
    target: null,
    ip: '10.0.0.4',
  },
  {
    id: 'e2',
    at: '2026-09-17T08:00:00.000Z',
    action: 'share.download',
    outcome: 'refused',
    actor: 'link 9f2a',
    target: 'client/brief.pdf',
    ip: '203.0.113.7',
  },
];

const page = (over = {}) => ({
  events: EVENTS,
  actions: ['sign-in', 'share.download'],
  enabled: true,
  nextBefore: null,
  ...over,
});

const open = async (body = page()) => {
  api.fetchActivity.mockResolvedValue(body);
  const wrapper = mount(SettingsActivity, { global: { mocks: { $t: (key) => key } } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  api.fetchActivity.mockReset();
  api.clearActivity.mockReset();
  store.settings.save.mockReset();
  store.settings.save.mockResolvedValue({});
  store.settings.systemSettings = { activity: { enabled: false, retentionDays: 90 } };
});

describe('the switch', () => {
  it('shows what is stored, and saves what was changed', async () => {
    const wrapper = await open();

    await wrapper.find('[data-test="activity-enabled"]').trigger('click');
    await wrapper.find('[data-test="activity-retention"]').setValue('14');
    await wrapper.find('[data-test="activity-save"]').trigger('click');
    await flushPromises();

    expect(store.settings.save).toHaveBeenCalledWith({
      activity: { enabled: true, retentionDays: 14 },
    });
  });

  it('will not save a retention that is not a number of days', async () => {
    const wrapper = await open();

    await wrapper.find('[data-test="activity-retention"]').setValue('0');

    expect(wrapper.find('[data-test="activity-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="activity-save"]').attributes('disabled')).toBeDefined();
  });

  it('has nothing to save until something changes', async () => {
    const wrapper = await open();

    expect(wrapper.find('[data-test="activity-save"]').attributes('disabled')).toBeDefined();
  });

  it('says so when the settings cannot be stored', async () => {
    store.settings.save.mockRejectedValue(new Error('the disk is full'));
    const wrapper = await open();

    await wrapper.find('[data-test="activity-enabled"]').trigger('click');
    await wrapper.find('[data-test="activity-save"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="activity-save-error"]').text()).toContain('the disk is full');
  });
});

describe('the list', () => {
  it('shows what was recorded, and marks a refusal', async () => {
    const wrapper = await open();

    const rows = wrapper.findAll('[data-test="activity-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('ada');
    expect(rows[1].text()).toContain('client/brief.pdf');
    expect(rows[1].text()).toContain('settings.activity.refused');
  });

  it('says the log is off rather than looking empty', async () => {
    const wrapper = await open(page({ enabled: false, events: [] }));

    expect(wrapper.find('[data-test="activity-off"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="activity-empty"]').exists()).toBe(false);
  });

  it('says there is nothing yet when the log is on and empty', async () => {
    const wrapper = await open(page({ events: [] }));

    expect(wrapper.find('[data-test="activity-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="activity-off"]').exists()).toBe(false);
  });

  it('asks the server to narrow, rather than filtering what it already has', async () => {
    const wrapper = await open();

    await wrapper.find('[data-test="activity-filter-action"]').setValue('sign-in');
    await flushPromises();

    expect(api.fetchActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'sign-in' })
    );
  });

  it('carries on from where the last page ended, keeping what is on screen', async () => {
    const wrapper = await open(page({ nextBefore: '2026-09-17T08:00:00.000Z' }));
    api.fetchActivity.mockResolvedValue(
      page({
        events: [{ ...EVENTS[0], id: 'e3', at: '2026-09-17T07:00:00.000Z' }],
        nextBefore: null,
      })
    );

    await wrapper.find('[data-test="activity-more"]').trigger('click');
    await flushPromises();

    expect(api.fetchActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: '2026-09-17T08:00:00.000Z' })
    );
    expect(wrapper.findAll('[data-test="activity-row"]')).toHaveLength(3);
    expect(wrapper.find('[data-test="activity-more"]').exists()).toBe(false);
  });

  it('empties it, and reads what is left', async () => {
    const wrapper = await open();
    api.clearActivity.mockResolvedValue({ removed: 2 });
    api.fetchActivity.mockResolvedValue(page({ events: [] }));

    await wrapper.find('[data-test="activity-clear"]').trigger('click');
    await flushPromises();

    expect(api.clearActivity).toHaveBeenCalled();
    expect(wrapper.findAll('[data-test="activity-row"]')).toHaveLength(0);
  });

  it('says so when the log cannot be read', async () => {
    api.fetchActivity.mockRejectedValue(new Error('no such table'));
    const wrapper = mount(SettingsActivity, { global: { mocks: { $t: (key) => key } } });
    await flushPromises();

    expect(wrapper.find('[data-test="activity-error"]').text()).toContain('no such table');
  });
});
