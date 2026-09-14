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

const VERSIONS = {
  enabled: true,
  keepAllHours: 24,
  hourlyDays: 7,
  dailyDays: 30,
  maxPerFile: 50,
  sessionCheckpointMinutes: 10,
};

const open = async ({
  trash = { enabled: true, retentionDays: 30, maxPercent: 10, maxBytes: null },
  versions = VERSIONS,
  zones = [zone()],
} = {}) => {
  appSettings = reactive({
    systemSettings: { trash, versions },
    save: vi.fn(async (partial) => {
      appSettings.systemSettings.trash = { ...appSettings.systemSettings.trash, ...partial.trash };
      appSettings.systemSettings.versions = {
        ...appSettings.systemSettings.versions,
        ...partial.versions,
      };
    }),
  });
  getTrashZones.mockResolvedValue({ zones });
  wrapper = mount(SettingsTrash);
  await flushPromises();
  return wrapper;
};

const input = (name) => wrapper.get(`[data-test="trash-settings-${name}"]`);
const versionInput = (name) => wrapper.get(`[data-test="versions-settings-${name}"]`);

beforeEach(() => {
  [getTrashZones, verifyTrash, runTrashMaintenance].forEach((mock) => mock.mockReset());
  features = reactive({ trashEnabled: true, trashRetentionDays: 30, versionsEnabled: true });
});

afterEach(() => {
  wrapper?.unmount();
});

describe('the version settings', () => {
  it('start from what is stored, with nothing to save', async () => {
    await open({ versions: { ...VERSIONS, keepAllHours: 48, maxPerFile: 20 } });

    expect(versionInput('keepAllHours').element.value).toBe('48');
    expect(versionInput('maxPerFile').element.value).toBe('20');
    expect(versionInput('dailyDays').element.value).toBe('30');
    expect(wrapper.find('[data-test="trash-settings-save"]').exists()).toBe(false);
  });

  it('save only the versions when only they changed, and tell the rest of the interface', async () => {
    await open();

    await versionInput('maxPerFile').setValue('20');
    await wrapper.get('[data-test="versions-settings-enabled"]').trigger('click');
    await wrapper.get('[data-test="trash-settings-save"]').trigger('click');
    await flushPromises();

    expect(appSettings.save).toHaveBeenCalledWith({
      versions: { ...VERSIONS, enabled: false, maxPerFile: 20 },
    });
    expect(features.versionsEnabled).toBe(false);
    expect(features.trashEnabled).toBe(true);
  });

  it('are switched off without touching the trash, and the trash without touching them', async () => {
    await open();

    await wrapper.get('[data-test="trash-settings-enabled"]').trigger('click');
    await wrapper.get('[data-test="trash-settings-save"]').trigger('click');
    await flushPromises();

    expect(appSettings.save.mock.calls[0][0]).not.toHaveProperty('versions');
    expect(features.trashEnabled).toBe(false);
    expect(features.versionsEnabled).toBe(true);
  });

  it('refuse values the thinning cannot work with, before anything is sent', async () => {
    await open();

    await versionInput('hourlyDays').setValue('0');

    expect(wrapper.find('[data-test="versions-settings-invalid"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="trash-settings-save"]').attributes('disabled')).toBeDefined();

    await versionInput('hourlyDays').setValue('7');
    await versionInput('maxPerFile').setValue('1001');
    expect(wrapper.find('[data-test="versions-settings-invalid"]').exists()).toBe(true);

    await versionInput('maxPerFile').setValue('50');
    expect(wrapper.find('[data-test="versions-settings-invalid"]').exists()).toBe(false);
  });

  it('show, per zone, the versions it holds within the same space as the trash', async () => {
    await open({
      zones: [
        zone({
          versionCount: 4,
          versionBytes: 25 * 1024 * 1024,
          events: [
            {
              id: 2,
              kind: 'version-evicted',
              itemName: 'notes.md',
              createdAt: '2026-09-14T09:00:00.000Z',
            },
          ],
        }),
      ],
    });

    const [item] = wrapper.findAll('[data-trash-zone]');
    expect(item.get('[data-trash-zone-versions]').text()).toContain('"count":4');
    // 50 MiB of trash and 25 MiB of versions, out of 200 MiB.
    expect(item.get('.bg-amber-500').attributes('style')).toContain('width: 38%');
    expect(item.get('[data-trash-zone-event]').text()).toContain(
      'settings.trash.events.versionEvicted {"name":"notes.md"}'
    );
  });

  it('say nothing about versions in a zone that holds none', async () => {
    await open();

    expect(wrapper.find('[data-trash-zone-versions]').exists()).toBe(false);
  });
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
