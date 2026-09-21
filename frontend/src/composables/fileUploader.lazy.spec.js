import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Uppy loaded when an upload is about to happen, and not with the page.
 *
 * The engine is replaced here by one whose arrival the test decides, which is
 * the whole of what is being checked: what happens before it is there, and
 * that nothing is handed to it until it is. What it does once there is
 * `fileUploader.spec.js`'s business, against the real one.
 */

const engine = vi.hoisted(() => ({
  create: null,
  instances: [],
}));

vi.mock('./uploadEngine', () => ({
  createUploadEngine: (...args) => engine.create(...args),
}));

vi.mock('@/api', () => ({
  reserveFolderUploadTarget: vi.fn(async (_to, root) => ({ targetRoot: root })),
}));

const stores = vi.hoisted(() => ({ file: {}, notifications: {}, settings: {} }));
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => stores.file }));
vi.mock('@/stores/notifications', () => ({ useNotificationsStore: () => stores.notifications }));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => stores.settings }));

const { useFileUploader, useUppyDropTarget } = await import('./fileUploader');

/** An engine that arrives when told to. */
const gatedEngine = () => {
  let release;
  let fail;
  const made = {
    addPickedFiles: vi.fn(),
    addDroppedFiles: vi.fn(),
    destroy: vi.fn(),
  };
  const ready = new Promise((resolve, reject) => {
    release = () => resolve(made);
    fail = (error) => reject(error);
  });
  engine.create = vi.fn(() => ready);
  engine.instances.push(made);
  return { made, release, fail };
};

const wrappers = [];
const mountWith = (setup) => {
  const wrapper = mount(defineComponent({ setup, render: () => null }));
  wrappers.push(wrapper);
  return wrapper;
};

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  setActivePinia(createPinia());
  engine.instances = [];
  Object.assign(stores.file, {
    currentPath: 'Docs',
    currentPathData: { canUpload: true, canWrite: true },
  });
  Object.assign(stores.notifications, { addNotification: vi.fn() });
  Object.assign(stores.settings, { ensureLoaded: vi.fn(async () => {}) });
});

afterEach(async () => {
  while (wrappers.length) wrappers.pop().unmount();
  await settle();
  document.querySelectorAll('input[type=file]').forEach((input) => input.remove());
});

describe('the page that loads first', () => {
  it('does not load the uploader by being shown', async () => {
    gatedEngine();
    mountWith(() => useFileUploader());
    await settle();

    expect(engine.create).not.toHaveBeenCalled();
  });

  // Found by the browser tests, not by these: the uploader was what loaded
  // the settings on a page reached through a share, and a document there
  // opened in place for somebody who had asked for a tab of its own.
  it('still loads the settings, which a page reached through a share relies on', async () => {
    gatedEngine();
    mountWith(() => useFileUploader());
    await settle();

    expect(stores.settings.ensureLoaded).toHaveBeenCalled();
    expect(engine.create).not.toHaveBeenCalled();
  });

  it('carries no part of Uppy that uploads', async () => {
    const source = (await import('./fileUploader.js?raw')).default;
    for (const name of ['@uppy/core', '@uppy/tus', '@uppy/xhr-upload', '@uppy/drop-target']) {
      expect(source).not.toContain(`'${name}'`);
    }
    expect(source).toContain("import('./uploadEngine')");
  });
});

describe('choosing files while the uploader loads', () => {
  const choose = async (uploader) => {
    const picked = uploader.openDialog();
    await settle();
    const input = document.querySelector('input[type=file]');
    return { picked, input };
  };

  // A browser refuses a file dialog opened after waiting on the network.
  it('opens the picker without waiting for it', async () => {
    const { made } = gatedEngine();
    let uploader;
    mountWith(() => (uploader = useFileUploader()));
    await settle();
    const input = document.querySelector('input[type=file]');
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});

    void uploader.openDialog();
    await settle();

    expect(click).toHaveBeenCalledTimes(1);
    expect(engine.create).toHaveBeenCalledTimes(1);
    expect(made.addPickedFiles).not.toHaveBeenCalled();
  });

  it('hands the chosen files over once it has loaded, and not before', async () => {
    const { made, release } = gatedEngine();
    let uploader;
    mountWith(() => (uploader = useFileUploader()));
    await settle();
    vi.spyOn(document.querySelector('input[type=file]'), 'click').mockImplementation(() => {});

    const { picked, input } = await choose(uploader);
    const chosen = input.onchange({
      target: { files: [new File(['x'], 'note.txt')], value: 'C:\\fakepath\\note.txt' },
    });
    await settle();
    expect(made.addPickedFiles).not.toHaveBeenCalled();

    release();
    await chosen;
    await picked;

    expect(made.addPickedFiles).toHaveBeenCalledTimes(1);
    expect(made.addPickedFiles.mock.calls[0][0].map((file) => file.name)).toEqual(['note.txt']);
  });

  it('says so when it cannot be loaded, and tries again next time', async () => {
    const first = gatedEngine();
    let uploader;
    mountWith(() => (uploader = useFileUploader()));
    await settle();
    vi.spyOn(document.querySelector('input[type=file]'), 'click').mockImplementation(() => {});

    const { picked, input } = await choose(uploader);
    first.fail(new Error('Failed to fetch dynamically imported module'));
    await input.onchange({ target: { files: [new File(['x'], 'a.txt')], value: '' } });
    await picked;

    expect(stores.notifications.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        heading: expect.stringMatching(/could not be loaded/),
      })
    );

    const second = gatedEngine();
    const again = await choose(uploader);
    second.release();
    await again.input.onchange({ target: { files: [new File(['x'], 'b.txt')], value: '' } });
    await again.picked;

    expect(second.made.addPickedFiles).toHaveBeenCalledTimes(1);
  });
});

describe('a drop that comes before the uploader', () => {
  const dropEvent = (type, files) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: ['Files'],
        files,
        items: files.map((file) => ({
          kind: 'file',
          webkitGetAsEntry: () => ({
            isFile: true,
            isDirectory: false,
            name: file.name,
            file: (ok) => ok(file),
          }),
          getAsFile: () => file,
        })),
        dropEffect: 'none',
      },
    });
    return event;
  };

  // A browser not told otherwise opens a dropped file in place of the page.
  it('keeps the browser from opening the file, and hands it over once loaded', async () => {
    const { made, release } = gatedEngine();
    const element = document.createElement('div');
    // Under the layout, which owns the uploads, as in the application.
    mountWith(() => useFileUploader());
    mountWith(() => useUppyDropTarget({ value: element }));
    await settle();

    const drop = dropEvent('drop', [new File(['x'], 'photo.jpg')]);
    element.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await settle();
    expect(made.addDroppedFiles).not.toHaveBeenCalled();

    release();
    await settle();

    expect(made.addDroppedFiles).toHaveBeenCalledTimes(1);
    expect(made.addDroppedFiles.mock.calls[0][0].map((file) => file.name)).toEqual(['photo.jpg']);
  });

  it('starts loading it as soon as a file is dragged over', async () => {
    gatedEngine();
    const element = document.createElement('div');
    // Under the layout, which owns the uploads, as in the application.
    mountWith(() => useFileUploader());
    mountWith(() => useUppyDropTarget({ value: element }));
    await settle();

    element.dispatchEvent(dropEvent('dragover', [new File(['x'], 'photo.jpg')]));
    await settle();

    expect(engine.create).toHaveBeenCalledTimes(1);
  });
});

describe('who takes the uploader down', () => {
  it('is whoever asked first, the layout — not a dialog that came and went', async () => {
    const { made, release } = gatedEngine();
    const layout = mountWith(() => useFileUploader());
    let dialog;
    const toolbar = mountWith(() => (dialog = useFileUploader()));
    await settle();
    vi.spyOn(document.querySelectorAll('input[type=file]')[1], 'click').mockImplementation(
      () => {}
    );

    void dialog.openDialog();
    release();
    await settle();

    toolbar.unmount();
    wrappers.splice(wrappers.indexOf(toolbar), 1);
    await settle();
    expect(made.destroy).not.toHaveBeenCalled();

    layout.unmount();
    wrappers.splice(wrappers.indexOf(layout), 1);
    await settle();
    expect(made.destroy).toHaveBeenCalledTimes(1);
  });
});
