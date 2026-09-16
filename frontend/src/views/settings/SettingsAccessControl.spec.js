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
    global: { config: { errorHandler: (error) => handlerErrors.push(error) } },
  });
  await flushPromises();
  return wrapper;
};

const rows = () => wrapper.findAll('tbody tr');
const row = (index) => rows()[index];
const button = (key) => wrapper.findAll('button').find((b) => b.text() === key);
const sent = () => appSettings.save.mock.calls.at(-1)[0];

const save = async () => {
  await button('common.save').trigger('click');
  await flushPromises();
};

beforeEach(() => {
  appSettings = null;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
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

    await row(1).get('button').trigger('click');

    expect(rows()).toHaveLength(2);
    expect(row(1).get('input').element.value).toBe('Public');

    await save();

    expect(sent().access.rules).toEqual([RULES[0], RULES[2]]);
  });

  it('sends an empty list when the last rule is removed', async () => {
    await open([RULES[0]]);

    await row(0).get('button').trigger('click');
    await save();

    expect(sent()).toEqual({ access: { rules: [] } });
  });
});

describe('discarding', () => {
  it('sends nothing and puts the stored rules back on screen', async () => {
    await open();

    await row(0).get('select').setValue('rw');
    await row(2).get('button').trigger('click');
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
