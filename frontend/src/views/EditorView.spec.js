import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';

/**
 * The text editor.
 *
 * 174 statements at five per cent, and what they hold is somebody's unsaved
 * work: whether the save button is live, whether leaving asks first, and
 * whether a listing that arrives late overwrites the file now on screen. It
 * serves two quite different situations from the same screen — a file of your
 * own, and a file reached through a share, which may be read-only — and telling
 * them apart wrongly either refuses a save that was allowed or offers one that
 * was not.
 */

const shared = vi.hoisted(() => ({ objects: {}, guards: [] }));

const api = vi.hoisted(() => ({
  fetchFileContent: vi.fn(async () => ({ content: 'hello' })),
  fetchSharedFileContent: vi.fn(async () => ({
    content: 'shared hello',
    name: 'notes.md',
    path: 'notes.md',
    canWrite: true,
    canDownload: true,
  })),
  saveFileContent: vi.fn(async () => ({})),
  saveSharedFileContent: vi.fn(async () => ({})),
  getRawFileUrl: vi.fn((path) => `/api/raw/${path}`),
  getDirectShareFileUrl: vi.fn((token, path, mode) => `/d/${token}/${path}?mode=${mode}`),
}));

vi.mock('@/api', () => ({
  ...api,
  fetchFileContent: (...args) => api.fetchFileContent(...args),
  fetchSharedFileContent: (...args) => api.fetchSharedFileContent(...args),
  saveFileContent: (...args) => api.saveFileContent(...args),
  saveSharedFileContent: (...args) => api.saveSharedFileContent(...args),
  getRawFileUrl: (...args) => api.getRawFileUrl(...args),
  getDirectShareFileUrl: (...args) => api.getDirectShareFileUrl(...args),
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));

vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  shared.objects.route = reactive({
    name: 'Editor',
    fullPath: '/editor/Docs/notes.md',
    params: { path: 'Docs/notes.md' },
  });
  return {
    useRoute: () => shared.objects.route,
    useRouter: () => router,
    onBeforeRouteLeave: (guard) => shared.guards.push(guard),
  };
});

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));

const folderScroll = vi.hoisted(() => ({ permitExplicitRestore: vi.fn() }));
vi.mock('@/stores/folderScroll', () => ({ useFolderScrollStore: () => folderScroll }));

// CodeMirror is a text area with a parser in it; nothing here is about that.
vi.mock('vue-codemirror', () => ({
  Codemirror: defineComponent({
    name: 'CodemirrorStub',
    props: ['modelValue'],
    emits: ['update:modelValue', 'ready'],
    render: () => null,
  }),
}));

const EditorViewComponent = (await import('./EditorView.vue')).default;

const route = () => shared.objects.route;

let wrapper = null;

const mountEditor = async () => {
  wrapper = mount(EditorViewComponent, {
    global: { mocks: { $t: (key) => key }, stubs: { Codemirror: true } },
  });
  await flushPromises();
  return wrapper.vm;
};

const asShare = () => {
  Object.assign(route(), {
    name: 'SharedEditor',
    fullPath: '/share/tok/edit/notes.md',
    params: { token: 'tok', sharedPath: 'notes.md' },
  });
};

const type = async (view, text) => {
  view.fileContent = text;
  await flushPromises();
};

beforeEach(() => {
  localStorage.clear();
  shared.guards.length = 0;
  Object.values(api).forEach((fn) => fn.mockClear());
  api.fetchFileContent.mockResolvedValue({ content: 'hello' });
  api.fetchSharedFileContent.mockResolvedValue({
    content: 'shared hello',
    name: 'notes.md',
    path: 'notes.md',
    canWrite: true,
    canDownload: true,
  });
  router.replace.mockClear();
  folderScroll.permitExplicitRestore.mockClear();
  Object.assign(route(), {
    name: 'Editor',
    fullPath: '/editor/Docs/notes.md',
    params: { path: 'Docs/notes.md', token: undefined, sharedPath: undefined },
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('opening a file', () => {
  it('reads the one the route names', async () => {
    await mountEditor();

    expect(api.fetchFileContent).toHaveBeenCalledWith('Docs/notes.md');
  });

  it('shows what came back', async () => {
    const view = await mountEditor();

    expect(view.fileContent).toBe('hello');
    expect(view.hasUnsavedChanges).toBe(false);
  });

  it('says why it could not', async () => {
    api.fetchFileContent.mockRejectedValue(new Error('File not found'));

    const view = await mountEditor();

    expect(view.loadError).toBe('File not found');
  });

  it('reads nothing at all when the route names no file', async () => {
    route().params = { path: '' };

    await mountEditor();

    expect(api.fetchFileContent).not.toHaveBeenCalled();
  });

  /**
   * Two files opened in quick succession answer in whatever order the network
   * feels like. The slower one arriving second must not replace the file the
   * reader is now looking at — and must not report its own failure either.
   */
  it('ignores an answer for a file no longer being edited', async () => {
    let answerFirst;
    api.fetchFileContent.mockImplementationOnce(
      () => new Promise((resolve) => { answerFirst = resolve; })
    );
    const view = await mountEditor();

    route().params = { path: 'Docs/other.md' };
    route().fullPath = '/editor/Docs/other.md';
    await flushPromises();
    answerFirst({ content: 'the old file' });
    await flushPromises();

    expect(view.fileContent).toBe('hello');
  });

  it('ignores a failure for a file no longer being edited', async () => {
    let failFirst;
    api.fetchFileContent.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failFirst = reject; })
    );
    const view = await mountEditor();

    route().params = { path: 'Docs/other.md' };
    route().fullPath = '/editor/Docs/other.md';
    await flushPromises();
    failFirst(new Error('too late'));
    await flushPromises();

    expect(view.loadError).toBe('');
  });
});

describe('opening a file through a share', () => {
  beforeEach(asShare);

  it('reads it through the share, with its token', async () => {
    await mountEditor();

    expect(api.fetchSharedFileContent).toHaveBeenCalledWith('tok', 'notes.md');
    expect(api.fetchFileContent).not.toHaveBeenCalled();
  });

  it('shows the name the share gave it', async () => {
    const view = await mountEditor();

    expect(view.displayPath).toBe('notes.md');
  });

  /** What the share allows is the share"s to say, not the editor"s to assume. */
  it('takes the share"s word for what may be done with it', async () => {
    api.fetchSharedFileContent.mockResolvedValue({
      content: 'x',
      name: 'notes.md',
      canWrite: false,
      canDownload: false,
    });

    const view = await mountEditor();

    expect(view.isSharedReadOnly).toBe(true);
    expect(view.sharedCanDownload).toBe(false);
  });

  it('never treats an own file as writable by a share', async () => {
    Object.assign(route(), { name: 'Editor', params: { path: 'Docs/notes.md' } });
    api.fetchFileContent.mockResolvedValue({ content: 'x', canWrite: true, canDownload: true });

    const view = await mountEditor();

    expect(view.sharedCanWrite).toBe(false);
    expect(view.sharedCanDownload).toBe(false);
  });
});

describe('whether saving is offered', () => {
  it('is not, until something is changed', async () => {
    const view = await mountEditor();

    expect(view.canSave).toBe(false);
  });

  it('is, once something is', async () => {
    const view = await mountEditor();

    await type(view, 'hello, world');

    expect(view.canSave).toBe(true);
    expect(view.hasUnsavedChanges).toBe(true);
  });

  it('is not while the file is still being read', async () => {
    api.fetchFileContent.mockImplementation(() => new Promise(() => {}));
    wrapper = mount(EditorViewComponent, {
      global: { mocks: { $t: (key) => key }, stubs: { Codemirror: true } },
    });
    await flushPromises();

    await type(wrapper.vm, 'anything');

    expect(wrapper.vm.canSave).toBe(false);
  });

  it('is not on a file that could not be read', async () => {
    api.fetchFileContent.mockRejectedValue(new Error('gone'));
    const view = await mountEditor();

    await type(view, 'anything');

    expect(view.canSave).toBe(false);
  });

  /** A read-only share is read-only however much is typed into it. */
  it('is not on a share that only allows reading', async () => {
    asShare();
    api.fetchSharedFileContent.mockResolvedValue({ content: 'x', name: 'n.md', canWrite: false });
    const view = await mountEditor();

    await type(view, 'anything');

    expect(view.canSave).toBe(false);
  });
});

describe('saving', () => {
  it('writes the file back', async () => {
    const view = await mountEditor();
    await type(view, 'hello, world');

    await view.saveFile();

    expect(api.saveFileContent).toHaveBeenCalledWith('Docs/notes.md', 'hello, world');
  });

  it('writes it back through the share it was opened from', async () => {
    asShare();
    const view = await mountEditor();
    await type(view, 'edited');

    await view.saveFile();

    expect(api.saveSharedFileContent).toHaveBeenCalledWith('tok', 'notes.md', 'edited');
  });

  it('stops calling it unsaved once it is saved', async () => {
    const view = await mountEditor();
    await type(view, 'hello, world');

    await view.saveFile();

    expect(view.hasUnsavedChanges).toBe(false);
  });

  /** Still unsaved: the marker is the only sign the work is still at risk. */
  it('keeps calling it unsaved when the write failed, and says why', async () => {
    api.saveFileContent.mockRejectedValue(new Error('Disk full'));
    const view = await mountEditor();
    await type(view, 'hello, world');

    await view.saveFile();

    expect(view.saveError).toBe('Disk full');
    expect(view.hasUnsavedChanges).toBe(true);
  });

  it('clears a stale complaint as soon as typing resumes', async () => {
    api.saveFileContent.mockRejectedValue(new Error('Disk full'));
    const view = await mountEditor();
    await type(view, 'hello, world');
    await view.saveFile();

    await type(view, 'hello again');

    expect(view.saveError).toBe('');
  });

  it('writes nothing when there is nothing to write', async () => {
    const view = await mountEditor();

    await view.saveFile();

    expect(api.saveFileContent).not.toHaveBeenCalled();
  });
});

describe('leaving the editor', () => {
  it('goes back to the folder the file lives in', async () => {
    const view = await mountEditor();

    view.requestClose();

    expect(router.replace).toHaveBeenCalledWith('/browse/Docs');
  });

  it('goes back to the root for a file that lives there', async () => {
    route().params = { path: 'notes.md' };
    const view = await mountEditor();

    view.requestClose();

    expect(router.replace).toHaveBeenCalledWith('/browse');
  });

  it('goes back to the share for a file opened through one', async () => {
    asShare();
    const view = await mountEditor();

    view.requestClose();

    expect(router.replace).toHaveBeenCalledWith('/share/tok');
  });

  /** Leaving with unsaved work is a decision, not a side effect of a click. */
  it('asks first when there is unsaved work', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = await mountEditor();
    await type(view, 'unsaved');

    view.requestClose();

    expect(confirmed).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    confirmed.mockRestore();
  });

  it('leaves when the answer is yes', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = await mountEditor();
    await type(view, 'unsaved');

    view.requestClose();

    expect(router.replace).toHaveBeenCalled();
    confirmed.mockRestore();
  });

  it('does not ask when there is nothing unsaved', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = await mountEditor();

    view.requestClose();

    expect(confirmed).not.toHaveBeenCalled();
    confirmed.mockRestore();
  });

  /**
   * Half a write is the one moment when leaving is genuinely unsafe — and the
   * one moment when saying yes to the question must not be enough.
   */
  it('refuses to leave in the middle of a write', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = await mountEditor();
    await type(view, 'unsaved');
    api.saveFileContent.mockImplementation(() => new Promise(() => {}));
    view.saveFile();
    await flushPromises();

    view.requestClose();

    expect(router.replace).not.toHaveBeenCalled();
    confirmed.mockRestore();
  });

  /**
   * The folder view is unmounted while a file is being edited, so it cannot
   * work out on its own that this was a return journey.
   */
  it('tells the folder it is coming back to that it may restore its place', async () => {
    await mountEditor();

    shared.guards.forEach((guard) =>
      guard({ name: 'FolderView', params: { path: 'Docs' } })
    );

    expect(folderScroll.permitExplicitRestore).toHaveBeenCalledWith('Docs');
  });

  it('says nothing to a folder it was not editing inside', async () => {
    await mountEditor();

    shared.guards.forEach((guard) =>
      guard({ name: 'FolderView', params: { path: 'Elsewhere' } })
    );

    expect(folderScroll.permitExplicitRestore).not.toHaveBeenCalled();
  });

  it('says nothing when leaving for anywhere else', async () => {
    await mountEditor();

    shared.guards.forEach((guard) => guard({ name: 'Settings', params: {} }));

    expect(folderScroll.permitExplicitRestore).not.toHaveBeenCalled();
  });
});

describe('looking at the file as it really is', () => {
  const opened = () => window.open.mock.calls.at(-1)?.[0];

  beforeEach(() => {
    vi.stubGlobal('open', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the raw file', async () => {
    const view = await mountEditor();

    view.openRaw();

    expect(opened()).toBe('/api/raw/Docs/notes.md');
  });

  it('opens it through the share when that is how it was reached', async () => {
    asShare();
    const view = await mountEditor();

    view.openRaw();

    expect(opened()).toBe('/d/tok/notes.md?mode=raw');
  });

  it('opens nothing when there is no file', async () => {
    route().params = { path: '' };
    const view = await mountEditor();

    view.openRaw();

    expect(window.open).not.toHaveBeenCalled();
  });

  it('downloads it when the share allows that', async () => {
    asShare();
    const view = await mountEditor();

    view.openDownload();

    expect(opened()).toBe('/d/tok/notes.md?mode=download');
  });

  it('downloads nothing when the share does not', async () => {
    asShare();
    api.fetchSharedFileContent.mockResolvedValue({
      content: 'x',
      name: 'n.md',
      canWrite: true,
      canDownload: false,
    });
    const view = await mountEditor();

    view.openDownload();

    expect(window.open).not.toHaveBeenCalled();
  });

  it('offers no download for a file of one"s own, which is not a share', async () => {
    const view = await mountEditor();

    view.openDownload();

    expect(window.open).not.toHaveBeenCalled();
  });
});

describe('choosing a theme', () => {
  it('remembers it for next time', async () => {
    const view = await mountEditor();

    view.updateTheme('githubLight');
    await flushPromises();

    expect(view.themeId).toBe('githubLight');
    expect(localStorage.getItem('editor:theme')).toContain('githubLight');
  });

  it('closes the menu once one is chosen', async () => {
    const view = await mountEditor();
    view.isThemeMenuOpen = true;

    view.updateTheme('githubLight');

    expect(view.isThemeMenuOpen).toBe(false);
  });

  it('offers no half of a merge view, which is not a theme', async () => {
    const view = await mountEditor();

    expect(view.themeOptions.some((option) => option.id.includes('Merge'))).toBe(false);
  });

  it('names the one in use, in words', async () => {
    const view = await mountEditor();

    view.updateTheme('githubLight');

    expect(view.currentThemeLabel).toBe('Github Light');
  });
});
