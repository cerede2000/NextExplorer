import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, reactive } from 'vue';

/**
 * The "Create new" menu: new folder, new file, blank documents, upload.
 *
 * Each entry writes into the folder on screen, and each one is allowed or
 * refused separately — a drop box may accept uploads but not new folders, a
 * share may allow neither. An entry left in the menu where the location refuses
 * it is a person invited to do something the server then rejects. Blank office
 * documents have a condition of their own: without an editor configured they
 * would be files the app can only download, so they are offered only when one
 * is.
 */

let fileStore;
let features;

const openDialog = vi.fn(async () => {});
const addNotification = vi.fn();
const openPreview = vi.fn();

vi.mock('@/composables/fileUploader', () => ({ useFileUploader: () => ({ openDialog }) }));
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => fileStore }));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification }),
}));
vi.mock('@/plugins/preview/manager', () => ({ usePreviewManager: () => ({ open: openPreview }) }));
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));
vi.mock('@/components/NewOfficeDocumentDialog.vue', () => ({
  default: defineComponent({
    name: 'NewOfficeDocumentDialogStub',
    props: { modelValue: Boolean, format: String, title: String, defaultName: String },
    emits: ['update:modelValue', 'create'],
    render: () => null,
  }),
}));

import CreateNew from './CreateNew.vue';

let wrapper = null;

const mountMenu = async () => {
  wrapper = mount(CreateNew, {
    attachTo: document.body,
    global: { mocks: { $t: (key) => key } },
  });
  await flushPromises();
  return wrapper;
};

const MAIN = 'create.createNew';

const openMenu = async () => {
  await wrapper.find(`button[title="${MAIN}"]`).trigger('click');
  await flushPromises();
};

/** The menu's entries, named by their translation keys; empty while it is shut. */
const entries = () =>
  wrapper
    .findAll('button:not([role="menuitem"])')
    .map((button) => button.text().trim())
    .filter((text) => text !== MAIN);

const entry = (key) => wrapper.findAll('button').find((button) => button.text().trim() === key);

const newFileRow = () => entry('actions.newFile').element.parentElement;

/** The drawer's document types, by extension. */
const drawer = () =>
  wrapper.findAll('[role="menuitem"]').map((button) => button.findAll('span').at(-1).text());

const openDrawer = async () => {
  newFileRow().dispatchEvent(new Event('mouseenter'));
  await flushPromises();
};

const documentType = (extension) =>
  wrapper
    .findAll('[role="menuitem"]')
    .find((button) => button.findAll('span').at(-1).text() === extension);

const dialog = () => wrapper.findComponent({ name: 'NewOfficeDocumentDialogStub' });

beforeEach(() => {
  fileStore = reactive({
    currentPathData: null,
    createFolder: vi.fn(async () => {}),
    createFile: vi.fn(async () => {}),
    createOfficeDocument: vi.fn(async () => null),
  });
  features = reactive({ onlyofficeEnabled: false, collaboraEnabled: false });
  [openDialog, addNotification, openPreview].forEach((fn) => fn.mockClear());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('what it offers', () => {
  it('stays shut until asked', async () => {
    await mountMenu();

    expect(entries()).toEqual([]);
  });

  it('offers every way to add something where the folder allows it', async () => {
    await mountMenu();
    await openMenu();

    expect(entries()).toEqual([
      'actions.newFolder',
      'actions.newFile',
      'actions.fileUpload',
      'actions.folderUpload',
    ]);
  });

  it('does not offer a new folder where folders cannot be created', async () => {
    fileStore.currentPathData = { canCreateFolder: false, canCreateFile: true, canUpload: true };
    await mountMenu();
    await openMenu();

    expect(entries()).toEqual(['actions.newFile', 'actions.fileUpload', 'actions.folderUpload']);
  });

  it('does not offer a new file, nor its drawer of documents, where files cannot be created', async () => {
    fileStore.currentPathData = { canCreateFolder: true, canCreateFile: false, canUpload: true };
    features.onlyofficeEnabled = true;
    await mountMenu();
    await openMenu();

    expect(entries()).toEqual(['actions.newFolder', 'actions.fileUpload', 'actions.folderUpload']);
    expect(drawer()).toEqual([]);
  });

  it('offers neither kind of upload where uploading is refused', async () => {
    fileStore.currentPathData = { canCreateFolder: true, canCreateFile: true, canUpload: false };
    await mountMenu();
    await openMenu();

    expect(entries()).toEqual(['actions.newFolder', 'actions.newFile']);
  });

  it('offers only uploads in a drop box', async () => {
    fileStore.currentPathData = { canCreateFolder: false, canCreateFile: false, canUpload: true };
    await mountMenu();
    await openMenu();

    expect(entries()).toEqual(['actions.fileUpload', 'actions.folderUpload']);
  });

  it('offers nothing in a read-only location', async () => {
    fileStore.currentPathData = { canCreateFolder: false, canCreateFile: false, canUpload: false };
    await mountMenu();
    await openMenu();

    expect(entries()).toEqual([]);
  });
});

describe('the drawer of document types', () => {
  it('lists only plain documents when no office editor is configured', async () => {
    await mountMenu();
    await openMenu();
    await openDrawer();

    expect(drawer()).toEqual(['.txt', '.md', '.csv']);
  });

  it('adds office documents when OnlyOffice is configured', async () => {
    features.onlyofficeEnabled = true;
    await mountMenu();
    await openMenu();
    await openDrawer();

    expect(drawer()).toEqual(['.docx', '.xlsx', '.pptx', '.pdf', '.txt', '.md', '.csv']);
  });

  it('adds office documents when Collabora is configured', async () => {
    features.collaboraEnabled = true;
    await mountMenu();
    await openMenu();
    await openDrawer();

    expect(drawer()).toEqual(['.docx', '.xlsx', '.pptx', '.pdf', '.txt', '.md', '.csv']);
  });

  it('opens with the right arrow and closes with the left one', async () => {
    await mountMenu();
    await openMenu();

    await entry('actions.newFile').trigger('keydown', { key: 'ArrowRight' });
    expect(drawer()).not.toEqual([]);

    await entry('actions.newFile').trigger('keydown', { key: 'ArrowLeft' });
    expect(drawer()).toEqual([]);
  });

  it('is shut again the next time the menu opens', async () => {
    await mountMenu();
    await openMenu();
    await openDrawer();
    expect(drawer()).not.toEqual([]);

    // Shut by clicking elsewhere, which is how it is shut in practice.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(entries()).toEqual([]);

    await openMenu();

    expect(entries()).toContain('actions.newFile');
    expect(drawer()).toEqual([]);
  });

  /**
   * The button sits outside the menu it opens. Counted as a click outside, it
   * shut the menu in the capture phase and its own toggle reopened it straight
   * away: the button could open the menu and never close it.
   */
  it('is shut by the button that opened it', async () => {
    await mountMenu();
    await openMenu();
    expect(entries()).toContain('actions.newFile');

    const button = wrapper.find(`button[title="${MAIN}"]`).element;
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await flushPromises();

    expect(entries()).toEqual([]);
  });
});

describe('what each entry does', () => {
  it('creates a folder in the current location and shuts the menu', async () => {
    await mountMenu();
    await openMenu();

    await entry('actions.newFolder').trigger('click');
    await flushPromises();

    expect(fileStore.createFolder).toHaveBeenCalledTimes(1);
    expect(fileStore.createFile).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  it('creates a file in the current location and shuts the menu', async () => {
    await mountMenu();
    await openMenu();

    await entry('actions.newFile').trigger('click');
    await flushPromises();

    expect(fileStore.createFile).toHaveBeenCalledTimes(1);
    expect(fileStore.createFolder).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  it('creates one folder however quickly it is clicked twice', async () => {
    let finish;
    fileStore.createFolder.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await mountMenu();
    await openMenu();

    await entry('actions.newFolder').trigger('click');
    await entry('actions.newFolder').trigger('click');
    finish();
    await flushPromises();

    expect(fileStore.createFolder).toHaveBeenCalledTimes(1);
  });

  it('lets you try again after a folder could not be created', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fileStore.createFolder.mockRejectedValueOnce(new Error('Disk full'));
    await mountMenu();
    await openMenu();
    await entry('actions.newFolder').trigger('click');
    await flushPromises();

    await openMenu();
    await entry('actions.newFolder').trigger('click');
    await flushPromises();

    expect(fileStore.createFolder).toHaveBeenCalledTimes(2);
  });

  it('lets you try again after a file could not be created', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fileStore.createFile.mockRejectedValueOnce(new Error('Disk full'));
    await mountMenu();
    await openMenu();
    await entry('actions.newFile').trigger('click');
    await flushPromises();

    await openMenu();
    await entry('actions.newFile').trigger('click');
    await flushPromises();

    expect(fileStore.createFile).toHaveBeenCalledTimes(2);
  });

  it('asks for files to upload', async () => {
    await mountMenu();
    await openMenu();

    await entry('actions.fileUpload').trigger('click');

    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(openDialog).toHaveBeenCalledWith();
  });

  it('asks for a folder to upload', async () => {
    await mountMenu();
    await openMenu();

    await entry('actions.folderUpload').trigger('click');

    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(openDialog).toHaveBeenCalledWith({ directory: true });
  });
});

describe('a new document from the drawer', () => {
  it('asks for a name first, for the type that was picked', async () => {
    features.onlyofficeEnabled = true;
    await mountMenu();
    expect(dialog().props('modelValue')).toBe(false);
    await openMenu();
    await openDrawer();

    await documentType('.xlsx').trigger('click');
    await flushPromises();

    expect(dialog().props()).toMatchObject({
      modelValue: true,
      format: 'xlsx',
      title: 'actions.newSpreadsheet',
      defaultName: 'create.defaultSpreadsheetName',
    });
    expect(entries()).toEqual([]);
    expect(fileStore.createOfficeDocument).not.toHaveBeenCalled();
  });

  it('creates the document under the name given, then opens it', async () => {
    const created = { name: 'Budget.xlsx', path: 'Docs', kind: 'xlsx' };
    fileStore.createOfficeDocument.mockResolvedValue(created);
    await mountMenu();

    dialog().vm.$emit('create', { format: 'xlsx', name: 'Budget' });
    await flushPromises();

    expect(fileStore.createOfficeDocument).toHaveBeenCalledWith({ format: 'xlsx', name: 'Budget' });
    expect(openPreview).toHaveBeenCalledWith(created);
  });

  it('says why a document could not be created, and opens nothing', async () => {
    fileStore.createOfficeDocument.mockRejectedValue(new Error('Quota exceeded'));
    await mountMenu();

    dialog().vm.$emit('create', { format: 'docx', name: 'Letter' });
    await flushPromises();

    expect(addNotification).toHaveBeenCalledWith({
      type: 'error',
      heading: 'create.documentFailed',
      body: 'Quota exceeded',
    });
    expect(openPreview).not.toHaveBeenCalled();
  });

  it('can create another document after one failed', async () => {
    fileStore.createOfficeDocument.mockRejectedValueOnce(new Error('Quota exceeded'));
    await mountMenu();

    dialog().vm.$emit('create', { format: 'docx', name: 'Letter' });
    await flushPromises();
    dialog().vm.$emit('create', { format: 'docx', name: 'Letter' });
    await flushPromises();

    expect(fileStore.createOfficeDocument).toHaveBeenCalledTimes(2);
  });
});
