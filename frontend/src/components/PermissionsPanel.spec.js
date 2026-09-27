import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

/**
 * The permissions section of the details panel.
 *
 * What it emits is handed straight to `chmod` and `chown` on the server, so a
 * wrong digit here changes who can read a file on disk. It reads the raw
 * `stats.mode` the server returns, lets somebody tick boxes, and emits a
 * three-digit mode; it also renames the owner or the group. It must emit only
 * what was actually changed, and nothing at all where the parent says the path
 * may not be changed (a share).
 */

import PermissionsPanel from './PermissionsPanel.vue';

// What `fs.stat` returns for a regular file with mode 640: type bits included.
const FILE_640 = { mode: 0o100640, owner: 'alice', group: 'staff' };
const DIR_755 = { mode: 0o040755, owner: 'alice', group: 'staff' };

let wrapper;

const open = (props = {}) => {
  wrapper = mount(PermissionsPanel, { props: { permissions: FILE_640, ...props } });
  return wrapper;
};

/** The nine boxes of the grid, owner/group/everyone by read/write/execute. */
const grid = () => wrapper.findAll('input[type="checkbox"]:not(#apply-to-items)');

/** The grid read back as `ls -l` would print it. */
const shown = () =>
  grid()
    .map((box, index) => (box.element.checked ? 'rwx'[index % 3] : '-'))
    .join('');

const box = (who, what) =>
  grid()[['owner', 'group', 'others'].indexOf(who) * 3 + ['r', 'w', 'x'].indexOf(what)];

const applyButton = () => wrapper.findAll('button').find((b) => b.text() === 'Apply');
const buttonLabelled = (text) => wrapper.findAll('button').find((b) => b.text() === text);

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('reading what the server returned', () => {
  it('shows the permission bits of the mode, ignoring the file type bits', () => {
    open();

    expect(shown()).toBe('rw-r-----');
    expect(wrapper.text()).toContain('640');
  });

  it('offers nothing to apply while the boxes still match the file', () => {
    open();

    expect(applyButton()).toBeUndefined();
  });

  it('takes a fresh read-back as the new starting point', async () => {
    open();
    await box('group', 'w').setValue(true);
    expect(applyButton()).toBeDefined();

    await wrapper.setProps({ permissions: { ...FILE_640, mode: 0o100660 } });

    expect(shown()).toBe('rw-rw----');
    expect(applyButton()).toBeUndefined();
  });
});

describe('changing the mode', () => {
  it('emits the mode the boxes now describe, once', async () => {
    open();

    await box('owner', 'x').setValue(true);
    await box('group', 'x').setValue(true);
    await applyButton().trigger('click');

    expect(wrapper.emitted('change-permissions')).toEqual([[{ mode: '750', recursive: false }]]);
  });

  it('emits a mode that takes permissions away, too', async () => {
    open({ permissions: { ...FILE_640, mode: 0o100777 } });

    await box('others', 'w').setValue(false);
    await box('others', 'x').setValue(false);
    await applyButton().trigger('click');

    expect(wrapper.emitted('change-permissions')[0][0].mode).toBe('774');
  });

  it('hides the button again when the boxes are put back as they were', async () => {
    open();

    await box('others', 'r').setValue(true);
    await box('others', 'r').setValue(false);

    expect(applyButton()).toBeUndefined();
  });

  it('never applies to the contents of a file, which has none', async () => {
    open();

    expect(wrapper.find('#apply-to-items').exists()).toBe(false);

    await box('group', 'w').setValue(true);
    await applyButton().trigger('click');

    expect(wrapper.emitted('change-permissions')[0][0].recursive).toBe(false);
  });

  it('applies to the contents of a folder only when that was ticked', async () => {
    open({ permissions: DIR_755, isDirectory: true });

    await box('others', 'r').setValue(false);
    await applyButton().trigger('click');
    await wrapper.get('#apply-to-items').setValue(true);
    await applyButton().trigger('click');

    expect(wrapper.emitted('change-permissions')).toEqual([
      [{ mode: '751', recursive: false }],
      [{ mode: '751', recursive: true }],
    ]);
  });
});

/**
 * The details panel keeps this component mounted when it moves to another item.
 * An owner or group typed for one file and left open must not be saved onto
 * the next one: that is a `chown` on a file nobody meant to change.
 */
describe('moving to another item while a name is being typed', () => {
  const CAROL_FILE = { mode: 0o100600, owner: 'carol', group: 'staff' };

  it('drops the owner being typed, and saves nothing onto the next item', async () => {
    open();
    await buttonLabelled('alice').trigger('click');
    await wrapper.get('input[type="text"]').setValue('bob');

    await wrapper.setProps({ permissions: CAROL_FILE });

    expect(wrapper.find('input[type="text"]').exists()).toBe(false);
    expect(buttonLabelled('Save')).toBeUndefined();
    expect(buttonLabelled('carol')).toBeDefined();
    expect(wrapper.emitted('change-owner')).toBeUndefined();
  });

  it('drops the group being typed too', async () => {
    open();
    await buttonLabelled('staff').trigger('click');
    await wrapper.get('input[type="text"]').setValue('wheel');

    await wrapper.setProps({ permissions: CAROL_FILE });
    await buttonLabelled('carol').trigger('click');
    await buttonLabelled('Save').trigger('click');

    expect(wrapper.emitted('change-owner')).toBeUndefined();
  });
});

describe('changing the owner or the group', () => {
  it('starts from the current owner and emits only the new owner', async () => {
    open();

    await buttonLabelled('alice').trigger('click');
    const field = wrapper.get('input[type="text"]');
    expect(field.element.value).toBe('alice');

    await field.setValue('bob');
    await buttonLabelled('Save').trigger('click');

    expect(wrapper.emitted('change-owner')).toEqual([[{ owner: 'bob' }]]);
    expect(wrapper.find('input[type="text"]').exists()).toBe(false);
  });

  it('emits only the new group, leaving the owner out', async () => {
    open();

    await buttonLabelled('staff').trigger('click');
    await wrapper.get('input[type="text"]').setValue('wheel');
    await wrapper.get('input[type="text"]').trigger('keyup.enter');

    expect(wrapper.emitted('change-owner')).toEqual([[{ group: 'wheel' }]]);
  });

  it('emits nothing when the name was left as it was', async () => {
    open();

    await buttonLabelled('alice').trigger('click');
    await buttonLabelled('Save').trigger('click');

    expect(wrapper.emitted('change-owner')).toBeUndefined();
    expect(wrapper.find('input[type="text"]').exists()).toBe(false);
  });

  it('emits nothing when the name was emptied', async () => {
    open();

    await buttonLabelled('staff').trigger('click');
    await wrapper.get('input[type="text"]').setValue('');
    await buttonLabelled('Save').trigger('click');

    expect(wrapper.emitted('change-owner')).toBeUndefined();
  });

  it('emits nothing when the edit is abandoned', async () => {
    open();

    await buttonLabelled('alice').trigger('click');
    await wrapper.get('input[type="text"]').setValue('mallory');
    await wrapper.get('input[type="text"]').trigger('keyup.escape');

    await buttonLabelled('staff').trigger('click');
    await wrapper.get('input[type="text"]').setValue('wheel');
    await buttonLabelled('Cancel').trigger('click');

    expect(wrapper.emitted('change-owner')).toBeUndefined();
    expect(wrapper.find('input[type="text"]').exists()).toBe(false);
  });
});

describe('where the parent says nothing may be changed', () => {
  it('shows the mode and the names but offers no way to change them', () => {
    open({ permissions: DIR_755, isDirectory: true, readOnly: true });

    expect(shown()).toBe('rwxr-xr-x');
    expect(grid().every((b) => b.attributes('disabled') !== undefined)).toBe(true);
    expect(buttonLabelled('alice')).toBeUndefined();
    expect(buttonLabelled('staff')).toBeUndefined();
    expect(wrapper.text()).toContain('alice');
    expect(wrapper.find('#apply-to-items').exists()).toBe(false);
  });

  it('withdraws a pending change once the path becomes read-only', async () => {
    open();
    await box('others', 'w').setValue(true);
    expect(applyButton()).toBeDefined();

    await wrapper.setProps({ readOnly: true });

    expect(applyButton()).toBeUndefined();
    expect(wrapper.emitted('change-permissions')).toBeUndefined();
  });
});

describe('while the permissions are not there', () => {
  it('offers no controls while they are being read', () => {
    open({ loading: true });

    expect(wrapper.text()).toContain('Loading permissions');
    expect(wrapper.findAll('input')).toHaveLength(0);
    expect(wrapper.findAll('button')).toHaveLength(0);
  });

  it('says they could not be read, and offers no controls built on a guess', () => {
    open({ permissions: null });

    expect(wrapper.text()).toContain('Unable to load permissions');
    expect(wrapper.findAll('input')).toHaveLength(0);
    expect(wrapper.findAll('button')).toHaveLength(0);
  });
});
