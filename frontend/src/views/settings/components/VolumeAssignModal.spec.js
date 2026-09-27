import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

/**
 * The dialog that gives a user a folder of the server as one of their volumes.
 *
 * The path it sends becomes the root of everything that user can reach, and
 * the access mode decides whether they can change it. Adding must send the
 * folder that was chosen, not the one being browsed; editing must never send a
 * path at all, since a volume's path cannot change. What the server refuses has
 * to reach the administrator.
 */

const api = vi.hoisted(() => ({
  browseAdminDirectories: vi.fn(),
  addUserVolume: vi.fn(),
  updateUserVolume: vi.fn(),
}));

vi.mock('@/api', () => ({
  browseAdminDirectories: (...args) => api.browseAdminDirectories(...args),
  addUserVolume: (...args) => api.addUserVolume(...args),
  updateUserVolume: (...args) => api.updateUserVolume(...args),
}));

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));

const VolumeAssignModal = (await import('./VolumeAssignModal.vue')).default;

const LISTINGS = {
  '': {
    current: '/mnt/data',
    parent: null,
    directories: [
      { name: 'Projects', path: '/mnt/data/Projects' },
      { name: 'Archive', path: '/mnt/data/Archive' },
    ],
  },
  '/mnt/data/Projects': {
    current: '/mnt/data/Projects',
    parent: '/mnt/data',
    directories: [{ name: 'Apollo', path: '/mnt/data/Projects/Apollo' }],
  },
  '/mnt/data': {
    current: '/mnt/data',
    parent: '/mnt',
    directories: [
      { name: 'Projects', path: '/mnt/data/Projects' },
      { name: 'Archive', path: '/mnt/data/Archive' },
    ],
  },
};

let wrapper;

const open = async (props = {}) => {
  wrapper = mount(VolumeAssignModal, { props: { userId: 'u-42', ...props } });
  await flushPromises();
  return wrapper;
};

const folder = (name) =>
  wrapper.findAll('.cursor-pointer').find((entry) => entry.text().includes(name));
const labelField = () => wrapper.get('#volume-label');
const footerButtons = () => wrapper.findAll('.border-t button');
const submitButton = () => footerButtons().at(-1);
const cancelButton = () => footerButtons()[0];
const errorShown = () => wrapper.find('.bg-red-50');

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.browseAdminDirectories.mockImplementation(async (path = '') => LISTINGS[path]);
  api.addUserVolume.mockResolvedValue({ id: 'v-1' });
  api.updateUserVolume.mockResolvedValue({ id: 'v-9' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/**
 * The form has one text field and its button outside it, so Enter in the label
 * submits it whatever state the button shows. A second submission before the
 * first answer used to reach the server and add the volume twice.
 */
describe('submitting twice', () => {
  it('sends the volume once while the first submission is on its way', async () => {
    let answer;
    api.addUserVolume.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    await open();
    await folder('Projects').trigger('click');

    await wrapper.get('form').trigger('submit');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(api.addUserVolume).toHaveBeenCalledTimes(1);
    answer({ id: 'v-1' });
    await flushPromises();
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });
});

describe('adding a volume', () => {
  it('opens on the top of what the server lets an administrator browse', async () => {
    await open();

    expect(api.browseAdminDirectories).toHaveBeenCalledWith('');
    expect(folder('Projects')).toBeDefined();
    expect(folder('Archive')).toBeDefined();
  });

  it('sends the chosen folder, named after it, read-write by default', async () => {
    await open();

    await folder('Projects').trigger('click');
    expect(labelField().element.value).toBe('Projects');
    await submitButton().trigger('click');
    await flushPromises();

    expect(api.addUserVolume).toHaveBeenCalledTimes(1);
    expect(api.addUserVolume).toHaveBeenCalledWith('u-42', {
      label: 'Projects',
      path: '/mnt/data/Projects',
      accessMode: 'readwrite',
    });
    expect(api.updateUserVolume).not.toHaveBeenCalled();
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });

  it('keeps a label that was typed, trimmed, and sends read-only when it was chosen', async () => {
    await open();

    await labelField().setValue('  Shared projects  ');
    await wrapper.get('#access-mode').setValue('readonly');
    await folder('Archive').trigger('click');
    await submitButton().trigger('click');
    await flushPromises();

    expect(api.addUserVolume).toHaveBeenCalledWith('u-42', {
      label: 'Shared projects',
      path: '/mnt/data/Archive',
      accessMode: 'readonly',
    });
  });

  /**
   * Browsing into a folder is not choosing it: the volume is the folder that
   * was clicked, wherever the browser has wandered since.
   */
  it('sends the folder that was chosen, not the one being browsed', async () => {
    await open();

    await folder('Projects').trigger('click');
    await folder('Projects').get('button').trigger('click');
    await flushPromises();

    expect(api.browseAdminDirectories).toHaveBeenLastCalledWith('/mnt/data/Projects');
    expect(folder('Apollo')).toBeDefined();

    await submitButton().trigger('click');
    await flushPromises();

    expect(api.addUserVolume.mock.calls[0][1].path).toBe('/mnt/data/Projects');
  });

  it('can choose the folder being browsed, and go back up from it', async () => {
    await open();

    await folder('Projects').get('button').trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'settings.users.selectThis')
      .trigger('click');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'settings.users.parentDirectory')
      .trigger('click');
    await flushPromises();

    expect(api.browseAdminDirectories).toHaveBeenLastCalledWith('/mnt/data');

    await submitButton().trigger('click');
    await flushPromises();

    expect(api.addUserVolume).toHaveBeenCalledWith('u-42', {
      label: 'Projects',
      path: '/mnt/data/Projects',
      accessMode: 'readwrite',
    });
  });

  it('cannot be sent before a folder is chosen', async () => {
    await open();
    await labelField().setValue('Projects');

    expect(submitButton().attributes('disabled')).toBeDefined();

    // Enter in the label field submits the form whatever the button says.
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(api.addUserVolume).not.toHaveBeenCalled();
    expect(errorShown().text()).toBe('errors.pathRequired');
    expect(wrapper.emitted('saved')).toBeUndefined();
  });

  it('is refused with a label of only spaces', async () => {
    await open();

    await folder('Projects').trigger('click');
    await labelField().setValue('   ');
    await submitButton().trigger('click');
    await flushPromises();

    expect(api.addUserVolume).not.toHaveBeenCalled();
    expect(errorShown().text()).toBe('errors.labelRequired');
  });

  it('says why the folders could not be listed', async () => {
    api.browseAdminDirectories.mockRejectedValue(new Error('Volume root is not mounted'));

    await open();

    expect(wrapper.text()).toContain('Volume root is not mounted');
    expect(wrapper.find('.cursor-pointer').exists()).toBe(false);
  });
});

describe('when the server refuses the volume', () => {
  it('shows its reason, stays open, and can be tried again', async () => {
    let refuse;
    api.addUserVolume.mockReturnValue(
      new Promise((_, reject) => {
        refuse = reject;
      })
    );
    await open();

    await folder('Projects').trigger('click');
    await submitButton().trigger('click');
    await flushPromises();

    expect(submitButton().attributes('disabled')).toBeDefined();
    expect(submitButton().text()).toBe('common.saving');

    refuse(new Error('This path is already assigned to the user'));
    await flushPromises();

    expect(errorShown().text()).toBe('This path is already assigned to the user');
    expect(wrapper.emitted('saved')).toBeUndefined();
    expect(submitButton().attributes('disabled')).toBeUndefined();
  });

  it('says it could not save when the refusal carries no reason', async () => {
    api.addUserVolume.mockRejectedValue({});
    await open();

    await folder('Projects').trigger('click');
    await submitButton().trigger('click');
    await flushPromises();

    expect(errorShown().text()).toBe('errors.saveVolume');
  });

  it('clears the previous reason on the next attempt', async () => {
    api.addUserVolume.mockRejectedValueOnce(new Error('Temporarily unavailable'));
    await open();

    await folder('Projects').trigger('click');
    await submitButton().trigger('click');
    await flushPromises();
    await submitButton().trigger('click');
    await flushPromises();

    expect(errorShown().exists()).toBe(false);
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });
});

describe('editing a volume', () => {
  const VOLUME = {
    id: 'v-9',
    label: 'Projects',
    path: '/mnt/data/Projects',
    accessMode: 'readonly',
  };

  it('starts from the volume and browses from the folder that holds it', async () => {
    await open({ editingVolume: VOLUME });

    expect(labelField().element.value).toBe('Projects');
    expect(wrapper.get('#access-mode').element.value).toBe('readonly');
    expect(api.browseAdminDirectories).toHaveBeenCalledWith('/mnt/data');
    expect(wrapper.text()).toContain('/mnt/data/Projects');
  });

  it('sends the label and the access mode, and never a path', async () => {
    await open({ editingVolume: VOLUME });

    await labelField().setValue(' Apollo ');
    await wrapper.get('#access-mode').setValue('readwrite');
    await submitButton().trigger('click');
    await flushPromises();

    expect(api.updateUserVolume).toHaveBeenCalledWith('u-42', 'v-9', {
      label: 'Apollo',
      accessMode: 'readwrite',
    });
    expect(api.addUserVolume).not.toHaveBeenCalled();
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });

  it('is refused with an empty label', async () => {
    await open({ editingVolume: VOLUME });

    await labelField().setValue('');
    await submitButton().trigger('click');
    await flushPromises();

    expect(api.updateUserVolume).not.toHaveBeenCalled();
    expect(errorShown().text()).toBe('errors.labelRequired');
  });
});

describe('closing the dialog', () => {
  it('sends nothing, from the cancel button, the cross or the backdrop', async () => {
    await open();
    await folder('Projects').trigger('click');

    await cancelButton().trigger('click');
    await wrapper.get('button .sr-only').element.parentElement.click();
    await wrapper.get('.backdrop-blur-xs').trigger('click');

    expect(wrapper.emitted('close')).toHaveLength(3);
    expect(api.addUserVolume).not.toHaveBeenCalled();
    expect(wrapper.emitted('saved')).toBeUndefined();
  });
});
