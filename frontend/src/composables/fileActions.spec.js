import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the explorer will and will not let you do.
 *
 * Every `canX` here stands between a person and an irreversible action, and
 * they had no test at all — 169 statements at 0%. The risk is not that a button
 * is missing: it is the opposite, a Delete that stays enabled on a read-only
 * share, or an Extract offered where nothing may be created. Each guard is
 * checked against the one permission that should switch it off, so a guard that
 * stops reading its permission fails here and only here.
 */

let storeState;
let featuresState;
const pick = vi.fn();

vi.mock('@/stores/fileStore', () => ({ useFileStore: () => storeState }));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => featuresState }));
vi.mock('@/composables/useDestinationPicker', () => ({
  useDestinationPicker: () => ({ pick }),
}));
vi.mock('@/api', () => ({
  buildUrl: (p) => `https://files.example.com${p}`,
  normalizePath: (p) =>
    String(p || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/|\/$/g, ''),
}));

import { useFileActions } from './fileActions';

const FILE = { name: 'report.docx', path: 'Docs', kind: 'docx' };
const ZIP = { name: 'backup.zip', path: 'Docs', kind: 'zip' };

/** Everything permitted, one ordinary file selected — the baseline each test bends. */
const setup = ({ selection = [FILE], permissions = {}, path = 'Docs', extra = {} } = {}) => {
  storeState = {
    selectedItems: selection,
    hasSelection: selection.length > 0,
    keyboardActionItem: null,
    currentPath: path,
    getCurrentPath: path,
    currentPathData: {
      canWrite: true,
      canCreateFolder: true,
      canCreateFile: true,
      canUpload: true,
      canDelete: true,
      canDownload: true,
      isDirectory: true,
      ...permissions,
    },
    hasClipboardItems: false,
    cutItems: [],
    copiedItems: [],
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    del: vi.fn(),
    beginRename: vi.fn(),
    extractZipArchive: vi.fn(),
    compressSelectionToZip: vi.fn(),
    transferSelectionTo: vi.fn(),
    ...extra,
  };
  featuresState = { archiveExtensions: ['zip', '7z', 'rar'] };
  return { actions: useFileActions(), store: storeState };
};

beforeEach(() => {
  pick.mockReset();
});

describe('each guard reads the permission it is named after', () => {
  it.each([
    ['canCut', 'canDelete'],
    ['canCut', 'canWrite'],
    ['canDelete', 'canDelete'],
    ['canRename', 'canWrite'],
  ])('%s goes false when %s does', (guard, permission) => {
    expect(setup().actions[guard].value).toBe(true);
    expect(setup({ permissions: { [permission]: false } }).actions[guard].value).toBe(false);
  });

  it('canCopy needs a selection and nothing else', () => {
    expect(setup({ permissions: { canWrite: false, canDelete: false } }).actions.canCopy.value).toBe(
      true
    );
    expect(setup({ selection: [] }).actions.canCopy.value).toBe(false);
  });

  it('canPaste needs a clipboard and somewhere to put it', () => {
    const clipboard = { extra: { hasClipboardItems: true } };
    expect(setup(clipboard).actions.canPaste.value).toBe(true);
    expect(setup().actions.canPaste.value).toBe(false);
    expect(
      setup({ ...clipboard, permissions: { canCreateFolder: false, canCreateFile: false } }).actions
        .canPaste.value
    ).toBe(false);
  });

  /** Either one is enough: a folder paste and a file paste are different asks. */
  it('canPaste survives losing just one of the two create rights', () => {
    const clipboard = { extra: { hasClipboardItems: true } };
    expect(
      setup({ ...clipboard, permissions: { canCreateFile: false } }).actions.canPaste.value
    ).toBe(true);
    expect(
      setup({ ...clipboard, permissions: { canCreateFolder: false } }).actions.canPaste.value
    ).toBe(true);
  });
});

describe('renaming', () => {
  it('refuses a volume, which is not a file to rename', () => {
    const volume = { name: 'Media', path: '', kind: 'volume' };
    expect(setup({ selection: [volume] }).actions.canRename.value).toBe(false);
  });

  /** The keyboard acts on what it is pointing at, not on what happens to be selected. */
  it('prefers the keyboard target over the selection', () => {
    const target = { name: 'other.txt', path: 'Docs', kind: 'txt' };
    const { actions, store } = setup({ extra: { keyboardActionItem: target } });

    actions.runRename();

    expect(store.beginRename).toHaveBeenCalledWith(target);
  });

  it('does nothing at all when it may not', () => {
    const { actions, store } = setup({ permissions: { canWrite: false } });

    actions.runRename();

    expect(store.beginRename).not.toHaveBeenCalled();
  });
});

describe('archives', () => {
  it('recognises one by kind', () => {
    expect(setup({ selection: [ZIP] }).actions.isArchiveSelected.value).toBe(true);
  });

  /** A file whose kind the listing did not fill in is still a .zip by name. */
  it('recognises one by extension when the kind is missing', () => {
    const noKind = { name: 'backup.7z', path: 'Docs' };
    expect(setup({ selection: [noKind] }).actions.isArchiveSelected.value).toBe(true);
  });

  it('does not offer a format this server cannot open', () => {
    featuresState = { archiveExtensions: ['zip'] };
    const rar = { name: 'old.rar', path: 'Docs', kind: 'rar' };
    const { actions } = setup({ selection: [rar] });
    featuresState.archiveExtensions = ['zip'];

    expect(actions.isArchiveSelected.value).toBe(false);
  });

  it('falls back to zip alone when the server said nothing', () => {
    const { actions } = setup({ selection: [ZIP] });
    featuresState.archiveExtensions = null;

    expect(actions.isArchiveSelected.value).toBe(true);
  });

  it('needs both create rights, because extracting makes files and folders', () => {
    expect(setup({ selection: [ZIP] }).actions.canExtractArchive.value).toBe(true);
    expect(
      setup({ selection: [ZIP], permissions: { canCreateFile: false } }).actions.canExtractArchive
        .value
    ).toBe(false);
    expect(
      setup({ selection: [ZIP], permissions: { canCreateFolder: false } }).actions.canExtractArchive
        .value
    ).toBe(false);
  });

  it('extracts to the archive path, and says where when asked', async () => {
    const { actions, store } = setup({ selection: [ZIP] });

    await actions.runExtractArchive();
    expect(store.extractZipArchive).toHaveBeenCalledWith('Docs/backup.zip');

    await actions.runExtractArchiveIntoCurrentFolder();
    expect(store.extractZipArchive).toHaveBeenLastCalledWith('Docs/backup.zip', {
      destination: 'current',
    });
  });

  it('refuses more than one selected item', () => {
    expect(setup({ selection: [ZIP, FILE] }).actions.isArchiveSelected.value).toBe(false);
  });
});

describe('compressing', () => {
  it('refuses a selection spread across folders', () => {
    const elsewhere = { name: 'note.txt', path: 'Other', kind: 'txt' };
    expect(setup({ selection: [FILE, elsewhere] }).actions.canCompressToZip.value).toBe(false);
  });

  it('accepts several items sharing a parent', () => {
    const sibling = { name: 'note.txt', path: 'Docs', kind: 'txt' };
    expect(setup({ selection: [FILE, sibling] }).actions.canCompressToZip.value).toBe(true);
  });

  /** Items at a volume root all have an empty parent, which is still one parent. */
  it('accepts items at the root of a volume', () => {
    const a = { name: 'a.txt', path: '', kind: 'txt' };
    const b = { name: 'b.txt', path: '', kind: 'txt' };
    expect(setup({ selection: [a, b], path: '' }).actions.canCompressToZip.value).toBe(true);
  });

  it('refuses to zip a volume', () => {
    const volume = { name: 'Media', path: '', kind: 'volume' };
    expect(setup({ selection: [volume] }).actions.canCompressToZip.value).toBe(false);
  });
});

describe('downloading', () => {
  const formSubmits = () => {
    const submit = vi.fn();
    // jsdom does not implement submission; the assertion is that it was asked.
    Object.defineProperty(window.HTMLFormElement.prototype, 'submit', {
      configurable: true,
      value: submit,
    });
    return submit;
  };

  it('posts one field per selected path', () => {
    const submit = formSubmits();
    const sibling = { name: 'note.txt', path: 'Docs', kind: 'txt' };
    const forms = [];
    const add = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      forms.push(node);
      return node;
    });
    vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node);

    setup({ selection: [FILE, sibling] }).actions.runDownload();

    expect(submit).toHaveBeenCalled();
    const paths = [...forms[0].querySelectorAll('input[name="paths"]')].map((i) => i.value);
    expect(paths).toEqual(['Docs/report.docx', 'Docs/note.txt']);
    expect(forms[0].querySelector('input[name="basePath"]').value).toBe('Docs');
    add.mockRestore();
    vi.restoreAllMocks();
  });

  it('submits nothing when nothing is selected', () => {
    const submit = formSubmits();

    setup({ selection: [] }).actions.runDownload();

    expect(submit).not.toHaveBeenCalled();
  });

  /**
   * Whole-folder download is a share-only affordance. Offering it elsewhere
   * points at an endpoint that will refuse.
   */
  it('offers the whole folder only inside a share', () => {
    expect(setup({ path: 'share/abc123' }).actions.canDownloadCurrentFolder.value).toBe(true);
    expect(setup({ path: 'Docs' }).actions.canDownloadCurrentFolder.value).toBe(false);
  });

  it('will not offer the whole folder without the download right', () => {
    expect(
      setup({ path: 'share/abc', permissions: { canDownload: false } }).actions
        .canDownloadCurrentFolder.value
    ).toBe(false);
  });

  it('will not offer the whole folder when the path is a file', () => {
    expect(
      setup({ path: 'share/abc', permissions: { isDirectory: false } }).actions
        .canDownloadCurrentFolder.value
    ).toBe(false);
  });
});

describe('moving and copying through the picker', () => {
  it('sends the chosen destination and the mode', async () => {
    pick.mockResolvedValue('Archive/2026');
    const { actions, store } = setup();

    await actions.runMoveTo();

    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ mode: 'move', from: 'Docs' }));
    expect(store.transferSelectionTo).toHaveBeenCalledWith('Archive/2026', 'move');
  });

  it('does nothing when the picker is dismissed', async () => {
    pick.mockResolvedValue(null);
    const { actions, store } = setup();

    await actions.runCopyTo();

    expect(store.transferSelectionTo).not.toHaveBeenCalled();
  });

  it('never opens the picker for an empty selection', async () => {
    const { actions } = setup({ selection: [] });

    await actions.runMoveTo();

    expect(pick).not.toHaveBeenCalled();
  });

  /**
   * The picker gets copies. Handing it the store's own objects lets a dialog
   * that mutates what it was given change the selection underneath.
   */
  it('hands the picker copies rather than the selected objects', async () => {
    pick.mockResolvedValue('Elsewhere');
    const { actions } = setup();

    await actions.runMoveTo();

    expect(pick.mock.calls[0][0].items[0]).not.toBe(FILE);
    expect(pick.mock.calls[0][0].items[0]).toEqual(FILE);
  });
});

describe('deleting', () => {
  it('refuses when the location does not allow it', async () => {
    const { actions, store } = setup({ permissions: { canDelete: false } });

    await actions.deleteNow();

    expect(store.del).not.toHaveBeenCalled();
  });

  /**
   * An explicit list is somebody else's decision — a share dialog, a drag —
   * that has done its own checking. The guard covers the selection only.
   */
  it('passes an explicit list through even where the selection could not be deleted', async () => {
    const { actions, store } = setup({ permissions: { canDelete: false } });
    const explicit = [{ name: 'x.txt', path: 'Docs' }];

    await actions.deleteNow(explicit);

    expect(store.del).toHaveBeenCalledWith(explicit, undefined);
  });
});

describe('the two helpers it exposes', () => {
  it('builds a path from an item and its parent', () => {
    const { actions } = setup();

    expect(actions.resolveItemPath({ name: 'a.txt', path: 'Docs/2026' })).toBe('Docs/2026/a.txt');
    expect(actions.resolveItemPath({ name: 'a.txt', path: '' })).toBe('a.txt');
    expect(actions.resolveItemPath({ path: 'Docs' })).toBe('');
    expect(actions.resolveItemPath(null)).toBe('');
  });

  /**
   * This is what stops a keyboard shortcut firing while somebody types a
   * filename into a rename box.
   */
  it('knows when the keyboard belongs to a field', () => {
    const { actions } = setup();
    const field = document.createElement('input');
    const area = document.createElement('textarea');
    const div = document.createElement('div');
    const rich = document.createElement('div');
    Object.defineProperty(rich, 'isContentEditable', { value: true });

    expect(actions.isEditableElement(field)).toBe(true);
    expect(actions.isEditableElement(area)).toBe(true);
    expect(actions.isEditableElement(rich)).toBe(true);
    expect(actions.isEditableElement(div)).toBe(false);
    expect(actions.isEditableElement(null)).toBe(false);
  });
});
