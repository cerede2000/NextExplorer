import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * The folder rules page, where an administrator makes a path read-only or
 * hidden for everybody.
 *
 * Saving replaces the whole list on the server, so what is sent must be
 * exactly the rows the administrator sees: a row dropped or a stale copy sent
 * back reopens a folder somebody meant to hide. Discarding must send nothing.
 */

let appSettings;

vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));

/** What the server says each path names; a folder unless a test says otherwise. */
const checkAccessRulePaths = vi.fn();
vi.mock('@/api', () => ({
  checkAccessRulePaths: (...args) => checkAccessRulePaths(...args),
  browse: vi.fn().mockResolvedValue({ items: [], path: '' }),
}));

/** The picker, reduced to what the page hands it and what it hands back. */
const picker = { props: null, emitSelect: null };
const StoragePickerStub = {
  name: 'StoragePickerDialog',
  // Typed as the real one types them: a bare `choose-folder` is true only for
  // a Boolean prop.
  props: { modelValue: Boolean, chooseFolder: Boolean, title: String, initialPath: String },
  emits: ['update:modelValue', 'select'],
  setup(props, { emit }) {
    picker.props = props;
    picker.emitSelect = (value) => {
      emit('select', value);
      emit('update:modelValue', false);
    };
    return () => null;
  },
};

import SettingsAccessControl from './SettingsAccessControl.vue';

const RULES = [
  { id: 'r1', path: 'Finance', recursive: true, permissions: 'ro' },
  { id: 'r2', path: 'HR/Payroll', recursive: true, permissions: 'hidden' },
  { id: 'r3', path: 'Public', recursive: false, permissions: 'rw' },
];

let wrapper;
let handlerErrors;

/** Replaces the stored list with what the server kept, as the real store does. */
const serverKeeps = (rules) => rules.map((rule) => ({ ...rule }));

const open = async (rules = RULES) => {
  appSettings = reactive({
    state: { access: { rules: rules.map((rule) => ({ ...rule })) } },
    save: vi.fn(async (partial) => {
      appSettings.state.access.rules = serverKeeps(partial.access.rules);
    }),
  });
  handlerErrors = [];
  wrapper = mount(SettingsAccessControl, {
    global: {
      config: { errorHandler: (error) => handlerErrors.push(error) },
      stubs: { StoragePickerDialog: StoragePickerStub },
    },
  });
  await flushPromises();
  return wrapper;
};

const rows = () => wrapper.findAll('tbody tr');
const row = (index) => rows()[index];
/** A row's own Remove button, and not whichever button comes first in it. */
const removeOf = (tr) => tr.findAll('button').find((b) => b.text() === 'common.remove');
const button = (key) => wrapper.findAll('button').find((b) => b.text() === key);
const sent = () => appSettings.save.mock.calls.at(-1)[0];

const save = async () => {
  await button('common.save').trigger('click');
  await flushPromises();
};

beforeEach(() => {
  appSettings = null;
  picker.props = null;
  checkAccessRulePaths.mockReset();
  checkAccessRulePaths.mockImplementation(async (paths) => ({
    paths: paths.map((path) => ({ path, status: 'folder', suggestion: null })),
  }));
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
});

describe('the rules as stored', () => {
  it('are shown one per row, with nothing to save', async () => {
    await open();

    expect(rows()).toHaveLength(3);
    expect(row(1).get('input').element.value).toBe('HR/Payroll');
    expect(row(1).get('select').element.value).toBe('hidden');
    expect(row(2).get('input[type="checkbox"]').element.checked).toBe(false);
    expect(button('common.save')).toBeUndefined();
  });

  it('are not touched by editing a row until it is saved', async () => {
    await open();

    await row(0).get('select').setValue('rw');
    await row(0).get('input').setValue('Finance/2026');

    expect(appSettings.state.access.rules[0]).toEqual(RULES[0]);
    expect(button('common.save')).toBeDefined();
    expect(appSettings.save).not.toHaveBeenCalled();
  });
});

describe('adding a rule', () => {
  it('starts read-only and recursive, and is sent with the rules already there', async () => {
    await open();

    await button('actions.addRule').trigger('click');
    const added = row(3);
    expect(added.get('select').element.value).toBe('ro');
    expect(added.get('input[type="checkbox"]').element.checked).toBe(true);

    await added.get('input:not([type])').setValue('Legal/Contracts');
    await added.get('select').setValue('hidden');
    await save();

    expect(appSettings.save).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual({
      access: {
        rules: [
          ...RULES,
          {
            id: expect.any(String),
            path: 'Legal/Contracts',
            recursive: true,
            permissions: 'hidden',
          },
        ],
      },
    });
  });

  it('sends a path without the slashes around it', async () => {
    await open([]);

    await button('actions.addRule').trigger('click');
    await row(0).get('input:not([type])').setValue('//Projects/Secret/');
    await save();

    expect(sent().access.rules.map((rule) => rule.path)).toEqual(['Projects/Secret']);
  });

  it('sends each new rule under its own id', async () => {
    await open([]);

    await button('actions.addRule').trigger('click');
    await button('actions.addRule').trigger('click');
    await row(0).get('input:not([type])').setValue('A');
    await row(1).get('input:not([type])').setValue('B');
    await save();

    const [first, second] = sent().access.rules;
    expect(first.id).not.toBe(second.id);
  });

  /**
   * A rule with no path used to be left out here, and the server dropped the
   * rules it could not store: either way the row left the page the moment it
   * was saved, and the folder it was meant to name was never protected. Every
   * row is sent, and the server answers with the rule it refused and why.
   */
  it.each([
    ['', 'empty'],
    ['///', 'only slashes'],
  ])('sends a row whose path is %j, %s, rather than dropping it', async (typed) => {
    await open();
    const refusal = 'Access rule 4: a rule needs the path of a folder.';
    appSettings.save.mockRejectedValue(new Error(refusal));

    await button('actions.addRule').trigger('click');
    await row(3).get('input:not([type])').setValue(typed);
    await save();

    expect(sent().access.rules).toHaveLength(4);
    expect(sent().access.rules.at(-1)).toMatchObject({ path: '' });
    // The row is still there to be corrected, with the reason beside it.
    expect(rows()).toHaveLength(4);
    expect(wrapper.get('[data-test="access-save-error"]').text()).toBe(refusal);
  });
});

describe('editing a rule', () => {
  it('sends the rule under the same id with what was changed, and the others as they were', async () => {
    await open();

    await row(0).get('select').setValue('rw');
    await row(0).get('input[type="checkbox"]').setValue(false);
    await row(0).get('input:not([type])').setValue('Finance/Archive');
    await save();

    expect(sent().access.rules).toEqual([
      { id: 'r1', path: 'Finance/Archive', recursive: false, permissions: 'rw' },
      RULES[1],
      RULES[2],
    ]);
  });
});

describe('removing a rule', () => {
  it('sends every other rule, in order', async () => {
    await open();

    await removeOf(row(1)).trigger('click');

    expect(rows()).toHaveLength(2);
    expect(row(1).get('input').element.value).toBe('Public');

    await save();

    expect(sent().access.rules).toEqual([RULES[0], RULES[2]]);
  });

  it('sends an empty list when the last rule is removed', async () => {
    await open([RULES[0]]);

    await removeOf(row(0)).trigger('click');
    await save();

    expect(sent()).toEqual({ access: { rules: [] } });
  });
});

describe('discarding', () => {
  it('sends nothing and puts the stored rules back on screen', async () => {
    await open();

    await row(0).get('select').setValue('rw');
    await removeOf(row(2)).trigger('click');
    await button('actions.addRule').trigger('click');
    await button('common.discard').trigger('click');
    await flushPromises();

    expect(appSettings.save).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(3);
    expect(row(0).get('select').element.value).toBe('ro');
    expect(button('common.save')).toBeUndefined();
  });
});

describe('after saving', () => {
  it('shows what the server kept, with nothing left to save', async () => {
    await open();
    appSettings.save.mockImplementation(async () => {
      appSettings.state.access.rules = [{ ...RULES[0], path: 'Finance' }];
    });

    await row(1).get('select').setValue('ro');
    await save();

    expect(rows()).toHaveLength(1);
    expect(button('common.save')).toBeUndefined();
  });

  it('keeps the edits on screen when the server refuses them', async () => {
    await open();
    appSettings.save.mockRejectedValue(new Error('Settings could not be saved'));

    await row(0).get('select').setValue('hidden');
    await save();

    expect(appSettings.save).toHaveBeenCalledTimes(1);
    expect(row(0).get('select').element.value).toBe('hidden');
    expect(button('common.save')).toBeDefined();
    // Said on the page, rather than thrown where nobody reads it.
    expect(wrapper.get('[data-test="access-save-error"]').text()).toBe(
      'Settings could not be saved'
    );
    expect(handlerErrors).toEqual([]);
  });

  it('clears the reason once a save goes through', async () => {
    await open();
    appSettings.save.mockRejectedValueOnce(new Error('Settings could not be saved'));

    await row(0).get('select').setValue('hidden');
    await save();
    expect(wrapper.find('[data-test="access-save-error"]').exists()).toBe(true);

    await save();

    expect(wrapper.find('[data-test="access-save-error"]').exists()).toBe(false);
  });
});

/**
 * A rule is matched against the path as NextExplorer shows it, volume first.
 * One typed from the host's side of a mount — `mnt/torrents` — was saved
 * without a word and matched nothing (nxzai/NextExplorer#407). The editor asks
 * the server what each path names, and warns without refusing: a rule may be
 * written for a folder that does not exist yet.
 */
describe('a path that names no folder', () => {
  const answers = (byPath) =>
    checkAccessRulePaths.mockImplementation(async (paths) => ({
      paths: paths.map((path) => ({
        path,
        status: 'folder',
        suggestion: null,
        ...(byPath[path] || {}),
      })),
    }));

  /** Past the pause the editor waits for, and past the answer. */
  const checked = async () => {
    vi.advanceTimersByTime(300);
    await flushPromises();
  };

  const RULE = { id: 'r1', path: 'mnt/torrents', recursive: true, permissions: 'ro' };

  it('is warned about, with the folder that was meant one click away', async () => {
    vi.useFakeTimers();
    answers({ 'mnt/torrents': { status: 'missing', suggestion: 'torrents' } });
    await open([RULE]);
    await checked();

    const warning = row(0).get('[data-test="access-rule-path-warning"]');
    expect(warning.text()).toContain('settings.access.pathMissing');

    await row(0).get('[data-test="access-rule-path-suggestion"]').trigger('click');
    expect(row(0).get('[data-test="access-rule-path"]').element.value).toBe('torrents');
    await checked();
    expect(row(0).find('[data-test="access-rule-path-warning"]').exists()).toBe(false);
  });

  it('is not warned about when it names a folder', async () => {
    vi.useFakeTimers();
    await open([{ ...RULE, path: 'torrents' }]);
    await checked();

    expect(checkAccessRulePaths).toHaveBeenCalledWith(['torrents']);
    expect(row(0).find('[data-test="access-rule-path-warning"]').exists()).toBe(false);
  });

  it('is warned about differently when it lies outside the volumes', async () => {
    vi.useFakeTimers();
    answers({ '../etc': { status: 'invalid' } });
    await open([{ ...RULE, path: '../etc' }]);
    await checked();

    const warning = row(0).get('[data-test="access-rule-path-warning"]');
    expect(warning.text()).toContain('settings.access.pathInvalid');
    expect(row(0).find('[data-test="access-rule-path-suggestion"]').exists()).toBe(false);
  });

  it('is still saved: a warning is not a refusal', async () => {
    vi.useFakeTimers();
    answers({ 'Projets/2027': { status: 'missing' } });
    await open([]);
    await button('actions.addRule').trigger('click');
    await row(0).get('[data-test="access-rule-path"]').setValue('Projets/2027');
    await checked();
    expect(row(0).find('[data-test="access-rule-path-warning"]').exists()).toBe(true);

    await save();

    expect(sent().access.rules.map((rule) => rule.path)).toEqual(['Projets/2027']);
  });

  it('is asked about once the typing stops, not at every key', async () => {
    vi.useFakeTimers();
    await open([{ ...RULE, path: '' }]);
    await checked();
    checkAccessRulePaths.mockClear();

    const input = row(0).get('[data-test="access-rule-path"]');
    for (const typed of ['t', 'to', 'tor', 'torrents']) {
      await input.setValue(typed);
      vi.advanceTimersByTime(100);
    }
    await checked();

    expect(checkAccessRulePaths).toHaveBeenCalledTimes(1);
    expect(checkAccessRulePaths).toHaveBeenCalledWith(['torrents']);
  });

  it('keeps the answer about the path on screen when an older one arrives late', async () => {
    vi.useFakeTimers();
    let answerLate;
    checkAccessRulePaths.mockImplementation((paths) =>
      paths[0] === 'torrent'
        ? new Promise((resolve) => {
            answerLate = () =>
              resolve({ paths: [{ path: 'torrent', status: 'folder', suggestion: null }] });
          })
        : Promise.resolve({
            paths: [{ path: 'mnt/torrents', status: 'missing', suggestion: 'torrents' }],
          })
    );
    await open([{ ...RULE, path: 'torrent' }]);
    vi.advanceTimersByTime(300);

    // Typed on while the first answer is still on its way.
    await row(0).get('[data-test="access-rule-path"]').setValue('mnt/torrents');
    await checked();
    expect(row(0).find('[data-test="access-rule-path-warning"]').exists()).toBe(true);

    answerLate();
    await flushPromises();

    // The late answer is about a path no longer there, and changes nothing.
    expect(row(0).find('[data-test="access-rule-path-warning"]').exists()).toBe(true);
  });

  it('leaves the editor working when the server cannot be asked', async () => {
    vi.useFakeTimers();
    checkAccessRulePaths.mockRejectedValue(new Error('offline'));
    await open([RULE]);
    await checked();

    expect(row(0).find('[data-test="access-rule-path-warning"]').exists()).toBe(false);
    await removeOf(row(0)).trigger('click');
    await save();
    expect(sent()).toEqual({ access: { rules: [] } });
  });
});

describe('choosing the folder rather than typing it', () => {
  it('opens the picker on the rule’s folder, and writes back the one chosen', async () => {
    await open();

    await row(1).get('[data-test="access-rule-browse"]').trigger('click');

    expect(picker.props.modelValue).toBe(true);
    expect(picker.props.chooseFolder).toBe(true);
    expect(picker.props.initialPath).toBe('HR/Payroll');

    picker.emitSelect('HR/Archives');
    await flushPromises();

    expect(row(1).get('[data-test="access-rule-path"]').element.value).toBe('HR/Archives');
    // The other rules are left as they were.
    expect(row(0).get('[data-test="access-rule-path"]').element.value).toBe('Finance');
    await save();
    expect(sent().access.rules[1]).toEqual({ ...RULES[1], path: 'HR/Archives' });
  });

  it('still lets the path be typed', async () => {
    await open([]);
    await button('actions.addRule').trigger('click');

    await row(0).get('[data-test="access-rule-path"]').setValue('Finance/2026');
    await save();

    expect(sent().access.rules[0].path).toBe('Finance/2026');
  });
});

describe('who the rules restrict', () => {
  // A read-only rule does not restrict an administrator and a hidden one does;
  // nothing on the page said either, and an administrator testing a rule on
  // their own account drew the wrong conclusion from it.
  it('is said on the page', async () => {
    await open();
    expect(wrapper.get('[data-test="access-admin-note"]').text()).toBe('settings.access.adminNote');
  });
});
