import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * The trash settings page: what is stored when an administrator saves, what is
 * refused before it reaches the server, and what each zone shows.
 */

const getTrashZones = vi.fn();
const verifyTrash = vi.fn();
const runTrashMaintenance = vi.fn();
let appSettings;
let features;

vi.mock('@/api', () => ({
  getTrashZones: (...args) => getTrashZones(...args),
  verifyTrash: (...args) => verifyTrash(...args),
  runTrashMaintenance: (...args) => runTrashMaintenance(...args),
}));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
const translate = (key, params) =>
  params && typeof params === 'object' ? `${key} ${JSON.stringify(params)}` : key;
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }));

import SettingsTrash from './SettingsTrash.vue';

const GIB = 1024 ** 3;

const zone = (overrides = {}) => ({
  id: 'z1',
  kind: 'volume',
  name: 'Projects',
  available: true,
  reason: null,
  itemCount: 3,
  usedBytes: 50 * 1024 * 1024,
  budgetBytes: 200 * 1024 * 1024,
  freeBytes: 1024 * GIB,
  lastPass: { at: '2026-09-14T10:00:00.000Z', purged: 2 },
  events: [{ id: 1, kind: 'evicted', itemName: 'old.iso', createdAt: '2026-09-14T09:00:00.000Z' }],
  ...overrides,
});

let wrapper;

const open = async ({
  trash = { enabled: true, retentionDays: 30, maxPercent: 10, maxBytes: null },
  zones = [zone()],
} = {}) => {
  appSettings = reactive({
    systemSettings: { trash },
    save: vi.fn(async (partial) => {
      appSettings.systemSettings.trash = { ...appSettings.systemSettings.trash, ...partial.trash };
    }),
  });
  getTrashZones.mockResolvedValue({ zones });
  wrapper = mount(SettingsTrash);
  await flushPromises();
  return wrapper;
};

const input = (name) => wrapper.get(`[data-test="trash-settings-${name}"]`);

beforeEach(() => {
  [getTrashZones, verifyTrash, runTrashMaintenance].forEach((mock) => mock.mockReset());
  features = reactive({ trashEnabled: true, trashRetentionDays: 30 });
});

afterEach(() => {
  wrapper?.unmount();
});

describe('the settings', () => {
  it('start from what is stored, with nothing to save', async () => {
    await open({ trash: { enabled: true, retentionDays: 14, maxPercent: 20, maxBytes: 5 * GIB } });

    expect(input('retention').element.value).toBe('14');
    expect(input('percent').element.value).toBe('20');
    expect(input('size').element.value).toBe('5');
    expect(wrapper.find('[data-test="trash-settings-save"]').exists()).toBe(false);
  });

  it('save what was changed, and tell the rest of the interface', async () => {
    await open();

    await input('retention').setValue('60');
    await input('size').setValue('2,5');
    await wrapper.get('[data-test="trash-settings-enabled"]').trigger('click');
    await wrapper.get('[data-test="trash-settings-save"]').trigger('click');
    await flushPromises();

    expect(appSettings.save).toHaveBeenCalledWith({
      trash: { enabled: false, retentionDays: 60, maxPercent: 10, maxBytes: Math.round(2.5 * GIB) },
    });
    expect(features.trashEnabled).toBe(false);
    expect(features.trashRetentionDays).toBe(60);
  });

  it('store no size cap when the field is left empty', async () => {
    await open({ trash: { enabled: true, retentionDays: 30, maxPercent: 10, maxBytes: GIB } });

    await input('size').setValue('');
    await wrapper.get('[data-test="trash-settings-save"]').trigger('click');
    await flushPromises();

    expect(appSettings.save.mock.calls[0][0].trash.maxBytes).toBeNull();
  });

  it('refuse values the trash cannot work with, before anything is sent', async () => {
    await open();

    await input('retention').setValue('0');

    expect(wrapper.find('[data-test="trash-settings-invalid"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="trash-settings-save"]').attributes('disabled')).toBeDefined();

    await input('retention').setValue('30');
    await input('percent').setValue('95');
    expect(wrapper.find('[data-test="trash-settings-invalid"]').exists()).toBe(true);

    await input('percent').setValue('10');
    await input('size').setValue('lots');
    expect(wrapper.find('[data-test="trash-settings-invalid"]').exists()).toBe(true);
  });
});

describe('the zones', () => {
  it('show what each holds, may hold, and what the last maintenance did', async () => {
    await open();

    const [item] = wrapper.findAll('[data-trash-zone]');
    expect(item.get('[data-trash-zone-name]').text()).toBe('Projects');
    expect(item.get('[data-trash-zone-state]').text()).toBe('settings.trash.available');
    expect(item.get('[data-trash-zone-usage]').text()).toContain('"count":3');
    expect(item.text()).toContain('settings.trash.lastPassPurged {"count":2}');
    expect(item.get('[data-trash-zone-event]').text()).toContain(
      'settings.trash.events.evicted {"name":"old.iso"}'
    );
  });

  it('name a personal folder and a zone that is not there', async () => {
    await open({
      zones: [
        zone({ id: 'a', kind: 'personal', name: 'alice' }),
        zone({ id: 'b', available: false, reason: 'replaced', budgetBytes: null }),
      ],
    });

    const [personal, missing] = wrapper.findAll('[data-trash-zone]');
    expect(personal.get('[data-trash-zone-name]').text()).toBe(
      'settings.trash.zoneKind.personal {"name":"alice"}'
    );
    expect(missing.get('[data-trash-zone-state]').text()).toBe(
      'settings.trash.unavailable.replaced'
    );
  });

  it('say what the check found, zone by zone', async () => {
    await open();
    verifyTrash.mockResolvedValue({
      zones: [{ zoneId: 'z1', violations: [{ invariant: 'I1', detail: 'content missing' }] }],
    });

    await wrapper.get('[data-test="trash-settings-verify"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test="trash-settings-verification"]').text()).toBe(
      'settings.trash.verifyIssues {"count":1}'
    );
    expect(wrapper.get('[data-trash-zone-violations]').text()).toContain('I1 — content missing');
  });

  it('say when every zone is consistent', async () => {
    await open();
    verifyTrash.mockResolvedValue({ zones: [{ zoneId: 'z1', violations: [] }] });

    await wrapper.get('[data-test="trash-settings-verify"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test="trash-settings-verification"]').text()).toBe(
      'settings.trash.verifyOk'
    );
  });

  it('reload once the maintenance has run', async () => {
    await open();
    runTrashMaintenance.mockResolvedValue({ zones: [] });

    await wrapper.get('[data-test="trash-settings-maintenance"]').trigger('click');
    await flushPromises();

    expect(runTrashMaintenance).toHaveBeenCalled();
    expect(getTrashZones).toHaveBeenCalledTimes(2);
  });
});
