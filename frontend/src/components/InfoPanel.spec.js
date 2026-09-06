import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * The details panel.
 *
 * 140 statements at 14.63%. Most of it is what a size means — an excluded
 * folder, a folder the index has measured, a folder it has not, a file that
 * carries its own — and one thing that is not cosmetic at all: this panel can
 * change the permissions and the owner of a file on the filesystem, and it must
 * not offer to do that through a share.
 */

const api = vi.hoisted(() => ({
  fetchMetadata: vi.fn(async () => ({ directory: null })),
  fetchPermissions: vi.fn(async () => ({ mode: '755', owner: 'root', group: 'root' })),
  changePermissions: vi.fn(async () => ({})),
  changeOwnership: vi.fn(async () => ({})),
}));

vi.mock('@/api', () => ({
  fetchMetadata: (...args) => api.fetchMetadata(...args),
  fetchPermissions: (...args) => api.fetchPermissions(...args),
  changePermissions: (...args) => api.changePermissions(...args),
  changeOwnership: (...args) => api.changeOwnership(...args),
}));

const panel = vi.hoisted(() => ({ store: null }));
const close = vi.hoisted(() => vi.fn());

vi.mock('@/stores/infoPanel', async () => {
  const { reactive } = await import('vue');
  panel.store = reactive({ isOpen: false, item: null, relativePath: '', close });
  return { useInfoPanelStore: () => panel.store };
});

const folderSize = vi.hoisted(() => ({
  sizeFor: vi.fn(() => null),
  refreshFolder: vi.fn(async () => {}),
}));
vi.mock('@/stores/folderSize', () => ({ useFolderSizeStore: () => folderSize }));

const features = vi.hoisted(() => ({ folderSizeEnabled: true }));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));

// Something in the import chain builds an i18n instance at load time, so the
// real module has to stay: only `useI18n` is replaced, to name each string by
// its key.
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));

const InfoPanel = (await import('./InfoPanel.vue')).default;

const FILE = { name: 'rapport.docx', path: 'Docs', kind: 'docx', size: 2048 };
const FOLDER = { name: 'Photos', path: 'Docs', kind: 'directory' };

let wrapper = null;

const mountPanel = async () => {
  wrapper = mount(InfoPanel, {
    global: {
      mocks: { $t: (key) => key },
      stubs: { FileIcon: true, MapPreview: true, PermissionsPanel: true },
    },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper.vm;
};

/** Opened on something, the way the store opens it. */
const openOn = async (item, relativePath = `${item.path}/${item.name}`) => {
  const view = await mountPanel();
  Object.assign(panel.store, { isOpen: true, item, relativePath });
  await flushPromises();
  return view;
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockClear());
  api.fetchMetadata.mockResolvedValue({ directory: null });
  api.fetchPermissions.mockResolvedValue({ mode: '755', owner: 'root', group: 'root' });
  api.changePermissions.mockResolvedValue({});
  api.changeOwnership.mockResolvedValue({});
  folderSize.sizeFor.mockReset();
  folderSize.sizeFor.mockReturnValue(null);
  folderSize.refreshFolder.mockReset();
  folderSize.refreshFolder.mockResolvedValue();
  close.mockClear();
  features.folderSizeEnabled = true;
  if (panel.store) Object.assign(panel.store, { isOpen: false, item: null, relativePath: '' });
  document.body.className = '';
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  document.body.className = '';
});

describe('the size it shows', () => {
  it('is the file"s own, for a file', async () => {
    const view = await openOn(FILE);

    expect(view.sizeLabel).toBe('2 KB');
  });

  it('is nothing for a file whose size never arrived', async () => {
    const view = await openOn({ ...FILE, size: undefined });

    expect(view.sizeLabel).toBe('');
  });

  it('is what the index measured, for a folder', async () => {
    folderSize.sizeFor.mockReturnValue({ sizeBytes: 5_000_000 });

    const view = await openOn(FOLDER);

    expect(view.sizeLabel).toBe('4.77 MB');
  });

  /**
   * A folder left out of the index has no size, and saying so is not the same
   * as printing a dash: one is a decision somebody made, the other is a gap.
   */
  it('says a folder was left out of the index rather than showing nothing', async () => {
    folderSize.sizeFor.mockReturnValue({ excluded: true });

    const view = await openOn(FOLDER);

    expect(view.sizeLabel).toBe('info.folderSizeExcluded');
  });

  it('is a dash for a folder the index has not reached yet', async () => {
    folderSize.sizeFor.mockReturnValue(null);

    const view = await openOn(FOLDER);

    expect(view.sizeLabel).toBe('—');
  });

  it('is nothing at all when nothing is open', async () => {
    const view = await mountPanel();

    expect(view.sizeLabel).toBe('');
  });
});

describe('the size in the folder section', () => {
  it('prefers what the index measured over what the listing counted', async () => {
    folderSize.sizeFor.mockReturnValue({ sizeBytes: 5_000_000 });
    api.fetchMetadata.mockResolvedValue({ directory: { totalSize: 9 } });

    const view = await openOn(FOLDER);

    expect(view.directorySizeLabel).toBe('4.77 MB');
  });

  it('falls back to what the listing counted where the index knows nothing', async () => {
    folderSize.sizeFor.mockReturnValue(null);
    api.fetchMetadata.mockResolvedValue({ directory: { totalSize: 1024 } });

    const view = await openOn(FOLDER);

    expect(view.directorySizeLabel).toBe('1 KB');
  });

  it('says the folder was left out, whatever the listing counted', async () => {
    folderSize.sizeFor.mockReturnValue({ excluded: true });
    api.fetchMetadata.mockResolvedValue({ directory: { totalSize: 1024 } });

    const view = await openOn(FOLDER);

    expect(view.directorySizeLabel).toBe('info.folderSizeExcluded');
  });

  it('is a dash when neither knows', async () => {
    const view = await openOn(FOLDER);

    expect(view.directorySizeLabel).toBe('—');
  });
});

describe('measuring a folder again', () => {
  it('asks the server to walk it', async () => {
    const view = await openOn(FOLDER);

    await view.refreshDirectorySize();

    expect(folderSize.refreshFolder).toHaveBeenCalledWith('Docs/Photos');
  });

  it('says why it could not', async () => {
    folderSize.refreshFolder.mockRejectedValue(new Error('Volume unreachable'));
    const view = await openOn(FOLDER);

    await view.refreshDirectorySize();

    expect(view.folderSizeRefreshError).toBe('Volume unreachable');
    expect(view.refreshingFolderSize).toBe(false);
  });

  it('is not offered for a file, which has nothing to walk', async () => {
    const view = await openOn(FILE);

    expect(view.canRefreshDirectorySize).toBe(false);

    await view.refreshDirectorySize();
    expect(folderSize.refreshFolder).not.toHaveBeenCalled();
  });

  it('is not offered where folder sizes are switched off', async () => {
    features.folderSizeEnabled = false;

    const view = await openOn(FOLDER);

    expect(view.canRefreshDirectorySize).toBe(false);
  });

  /** Walking a large tree twice at once helps nobody. */
  it('does not start a second walk while one is running', async () => {
    let release;
    folderSize.refreshFolder.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const view = await openOn(FOLDER);

    const first = view.refreshDirectorySize();
    await view.refreshDirectorySize();
    release();
    await first;

    expect(folderSize.refreshFolder).toHaveBeenCalledTimes(1);
  });
});

describe('what it reads when it opens', () => {
  it('reads the details and the permissions of what was opened', async () => {
    await openOn(FILE);

    expect(api.fetchMetadata).toHaveBeenCalledWith('Docs/rapport.docx');
    expect(api.fetchPermissions).toHaveBeenCalledWith('Docs/rapport.docx');
  });

  it('reads them again when it is pointed at something else', async () => {
    await openOn(FILE);
    api.fetchMetadata.mockClear();

    Object.assign(panel.store, { item: FOLDER, relativePath: 'Docs/Photos' });
    await flushPromises();

    expect(api.fetchMetadata).toHaveBeenCalledWith('Docs/Photos');
  });

  /**
   * Reopened on the same file, nothing about the path has changed — and the
   * details are still worth reading again, because the file may not be what it
   * was when the panel was last closed.
   */
  it('reads them again when it is reopened on the same thing', async () => {
    await openOn(FILE);
    panel.store.isOpen = false;
    await flushPromises();
    api.fetchMetadata.mockClear();
    api.fetchPermissions.mockClear();

    panel.store.isOpen = true;
    await flushPromises();

    expect(api.fetchMetadata).toHaveBeenCalledWith('Docs/rapport.docx');
    expect(api.fetchPermissions).toHaveBeenCalledWith('Docs/rapport.docx');
  });

  it('reads nothing while it is shut', async () => {
    await mountPanel();

    Object.assign(panel.store, { item: FILE, relativePath: 'Docs/rapport.docx' });
    await flushPromises();

    expect(api.fetchMetadata).not.toHaveBeenCalled();
  });

  it('says why the details would not come', async () => {
    api.fetchMetadata.mockRejectedValue(new Error('Path no longer exists'));

    const view = await openOn(FILE);

    expect(view.errorMsg).toBe('Path no longer exists');
    expect(view.loading).toBe(false);
  });

  it('says why the permissions would not come', async () => {
    api.fetchPermissions.mockRejectedValue(new Error('Not permitted'));

    const view = await openOn(FILE);

    expect(view.permissionsError).toBe('Not permitted');
    expect(view.permissionsLoading).toBe(false);
  });
});

describe('changing what a file allows', () => {
  it('sets the mode, and reads back what actually took', async () => {
    const view = await openOn(FILE);
    api.fetchPermissions.mockClear();

    await view.handleChangePermissions({ mode: '640', recursive: false });

    expect(api.changePermissions).toHaveBeenCalledWith('Docs/rapport.docx', '640', false);
    expect(api.fetchPermissions).toHaveBeenCalled();
  });

  it('sets the owner the same way', async () => {
    const view = await openOn(FILE);
    api.fetchPermissions.mockClear();

    await view.handleChangeOwner({ owner: 'benjy', group: 'staff' });

    expect(api.changeOwnership).toHaveBeenCalledWith('Docs/rapport.docx', 'benjy', 'staff');
    expect(api.fetchPermissions).toHaveBeenCalled();
  });

  /**
   * A share grants access to a file, never the run of the filesystem it sits
   * on. Changing a mode or an owner through one is a different thing entirely
   * from reading it.
   */
  it('is refused on a path reached through a share', async () => {
    const view = await openOn(FILE, 'share/abc123/rapport.docx');

    await view.handleChangePermissions({ mode: '777', recursive: true });
    await view.handleChangeOwner({ owner: 'root', group: 'root' });

    expect(api.changePermissions).not.toHaveBeenCalled();
    expect(api.changeOwnership).not.toHaveBeenCalled();
  });

  it('is refused with no path at all', async () => {
    const view = await mountPanel();

    await view.handleChangePermissions({ mode: '777', recursive: false });

    expect(api.changePermissions).not.toHaveBeenCalled();
  });

  it('says why the mode would not change, and stops looking busy', async () => {
    api.changePermissions.mockRejectedValue(new Error('Operation not permitted'));
    const view = await openOn(FILE);

    await view.handleChangePermissions({ mode: '640', recursive: false });

    expect(view.permissionsError).toBe('Operation not permitted');
    expect(view.permissionsLoading).toBe(false);
  });

  it('says why the owner would not change', async () => {
    api.changeOwnership.mockRejectedValue(new Error('Unknown user'));
    const view = await openOn(FILE);

    await view.handleChangeOwner({ owner: 'nobody', group: 'nobody' });

    expect(view.permissionsError).toBe('Unknown user');
  });
});

describe('closing it', () => {
  it('closes on Escape', async () => {
    await openOn(FILE);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();

    expect(close).toHaveBeenCalled();
  });

  it('ignores Escape while it is already shut', async () => {
    await mountPanel();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();

    expect(close).not.toHaveBeenCalled();
  });

  it('ignores any other key', async () => {
    await openOn(FILE);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await flushPromises();

    expect(close).not.toHaveBeenCalled();
  });

  /** The page behind must not scroll away under the panel. */
  it('holds the page still while it is open, and gives it back', async () => {
    await openOn(FILE);
    expect(document.body.classList.contains('overflow-hidden')).toBe(true);

    panel.store.isOpen = false;
    await flushPromises();

    expect(document.body.classList.contains('overflow-hidden')).toBe(false);
  });

  it('stops listening once it is gone', async () => {
    await openOn(FILE);

    wrapper.unmount();
    wrapper = null;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();

    expect(close).not.toHaveBeenCalled();
  });
});
