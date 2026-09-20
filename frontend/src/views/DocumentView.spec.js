import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive, ref } from 'vue';

/**
 * A document at an address of its own.
 *
 * The page itself shows nothing — the preview does that, exactly as it does
 * over a folder. What this page owns is everything around it: which document
 * is opened, what happens when it closes, and what the server is told when the
 * tab is shut. That last one is the whole reason it is not simply a route with
 * a component behind it: a document closed by closing its tab has to stop
 * being reported as open, or the lock somebody else sees never clears.
 */

const routePath = ref('Docs/report.docx');
const replace = vi.fn();
const open = vi.fn(() => true);
const close = vi.fn();
const endForUnload = vi.fn(() => true);
const fetchPathItems = vi.fn(async () => {});
const pluginsReady = vi.fn(async () => {});
let editableExtensions = ['txt', 'md'];

const previewManager = reactive({ isOpen: false });

vi.mock('vue-router', () => ({
  useRoute: () => ({
    get params() {
      return { path: routePath.value };
    },
  }),
  useRouter: () => ({ replace }),
}));

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({
    t: (key, values) =>
      values && typeof values === 'object' ? `${key}:${Object.values(values).join(',')}` : key,
  }),
}));

vi.mock('@/api', () => ({
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

vi.mock('@/plugins/preview/manager', () => ({
  usePreviewManager: () => ({
    get isOpen() {
      return previewManager.isOpen;
    },
    open: (...args) => open(...args),
    close: (...args) => close(...args),
    endForUnload: (...args) => endForUnload(...args),
  }),
}));

vi.mock('@/plugins', () => ({ whenPreviewPluginsReady: () => pluginsReady() }));

vi.mock('@/plugins/preview/PreviewHost.vue', () => ({
  default: { name: 'PreviewHost', template: '<div data-test="preview-host" />' },
}));

vi.mock('@/stores/fileStore', () => ({
  useFileStore: () => ({ fetchPathItems: (...args) => fetchPathItems(...args) }),
}));

vi.mock('@/config/editor', () => ({
  isEditableExtension: (extension) => editableExtensions.includes(extension),
}));

const DocumentView = (await import('./DocumentView.vue')).default;

/**
 * One page at a time.
 *
 * Every mounted page listens for `pagehide` on the window, so a page left
 * mounted by an earlier test answers this one's events too — which reads as
 * "the handler fired six times" and sends whoever looks at it hunting for a
 * loop that is not there.
 */
let wrapper = null;

const show = async (path = 'Docs/report.docx') => {
  routePath.value = path;
  wrapper = mount(DocumentView);
  await flushPromises();
  return wrapper;
};

/**
 * Whether the browser honoured the close. A tab that really closed is gone, so
 * `window.closed` is the only thing the page can ask afterwards — and it is
 * what decides whether the fallback runs.
 */
let closed = true;
/** How many entries this tab's history holds; one means it is dedicated. */
let historyLength = 1;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'close').mockImplementation(() => {});
  Object.defineProperty(window, 'closed', { configurable: true, get: () => closed });
  Object.defineProperty(window.history, 'length', {
    configurable: true,
    get: () => historyLength,
  });
  closed = true;
  historyLength = 1;
  replace.mockClear();
  open.mockClear();
  open.mockReturnValue(true);
  close.mockClear();
  endForUnload.mockClear();
  fetchPathItems.mockClear();
  pluginsReady.mockClear();
  pluginsReady.mockResolvedValue(undefined);
  previewManager.isOpen = false;
  editableExtensions = ['txt', 'md'];
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('opening a document at its own address', () => {
  it('opens the document the address names', async () => {
    await show('Docs/Reports/report.docx');

    expect(open).toHaveBeenCalledWith({ name: 'report.docx', path: 'Docs/Reports' });
  });

  it('names its browser tab after the document', async () => {
    await show('Docs/Reports/report.docx');

    // Several of these are open at once by design; tabs that all read
    // "Explorer" are tabs nobody can tell apart.
    expect(window.document.title).toBe('report.docx');
  });

  it('loads the folder behind it, so the arrows still move between files', async () => {
    await show('Photos/2026/first.jpg');

    // The plugins read the siblings from the file store, which on this page has
    // never been to that folder — without this, "next photograph" would be the
    // one thing that works over a listing and not here.
    expect(fetchPathItems).toHaveBeenCalledWith('Photos/2026');
  });

  it('waits for the editors to register before deciding nothing opens it', async () => {
    const order = [];
    pluginsReady.mockImplementation(async () => {
      order.push('plugins');
    });
    open.mockImplementation(() => {
      order.push('open');
      return true;
    });

    await show();

    // ONLYOFFICE and Collabora register once the server has said they are
    // configured. Asking first would answer "nothing opens this" about a
    // document one of them was a moment from claiming.
    expect(order).toEqual(['plugins', 'open']);
  });

  it('shows a way out when nothing can open it', async () => {
    open.mockReturnValue(false);
    const wrapper = await show('Docs/firmware.bin');

    expect(wrapper.find('[data-test="document-unopenable"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('preview.nothingOpensIt:firmware.bin');

    await wrapper.find('[data-test="document-back"]').trigger('click');
    expect(replace).toHaveBeenCalledWith({
      path: '/browse/Docs',
      query: { select: 'firmware.bin' },
    });
  });

  it('hands a file only the editor opens to the editor', async () => {
    open.mockReturnValue(false);
    const wrapper = await show('Docs/notes.txt');

    expect(replace).toHaveBeenCalledWith({ path: '/editor/Docs/notes.txt' });
    expect(wrapper.find('[data-test="document-unopenable"]').exists()).toBe(false);
  });

  /**
   * The close button belongs to the document, and a document with a tab to
   * itself is closed by closing the tab. It used to send the tab to the folder
   * listing instead, which left two identical explorer tabs open and nothing
   * to tell them apart (nxzai#303).
   */
  it('closes the tab when the document is closed', async () => {
    previewManager.isOpen = true;
    const wrapper = await show('Docs/Reports/report.docx');

    previewManager.isOpen = false;
    await flushPromises();

    expect(window.close).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  // Where the browser refuses — an address pasted into a tab that has already
  // been somewhere — closing must still land the reader somewhere rather than
  // leaving them in front of a document they have just shut.
  it('falls back to the folder when the browser refuses to close', async () => {
    closed = false;
    previewManager.isOpen = true;
    const wrapper = await show('Docs/Reports/report.docx');

    previewManager.isOpen = false;
    await flushPromises();
    await vi.advanceTimersByTimeAsync(200);

    expect(replace).toHaveBeenCalledWith({
      path: '/browse/Docs/Reports',
      query: { select: 'report.docx' },
    });
    wrapper.unmount();
  });

  it('does not go to the folder when the tab really closed', async () => {
    closed = true;
    previewManager.isOpen = true;
    const wrapper = await show('Docs/Reports/report.docx');

    previewManager.isOpen = false;
    await flushPromises();
    await vi.advanceTimersByTimeAsync(200);

    expect(replace).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  // The tab somebody opened the whole application in is also "created by web
  // content". Closing it because they shut a document would take the rest of
  // their session with it, so a tab that has been anywhere else is navigated
  // rather than closed.
  it('goes to the folder when the tab has been somewhere else', async () => {
    historyLength = 4;
    previewManager.isOpen = true;
    const wrapper = await show('Docs/Reports/report.docx');

    previewManager.isOpen = false;
    await flushPromises();

    expect(window.close).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith({
      path: '/browse/Docs/Reports',
      query: { select: 'report.docx' },
    });
    wrapper.unmount();
  });

  it('opens the next document when the address changes under it', async () => {
    const wrapper = await show('Docs/first.docx');
    expect(open).toHaveBeenCalledWith({ name: 'first.docx', path: 'Docs' });

    routePath.value = 'Docs/second.docx';
    await flushPromises();

    expect(open).toHaveBeenLastCalledWith({ name: 'second.docx', path: 'Docs' });
    wrapper.unmount();
  });
});

describe('leaving the page', () => {
  it('tells the plugin the page is going away when the tab closes', async () => {
    const wrapper = await show();

    window.dispatchEvent(new Event('pagehide'));

    // The editing session ends here or it does not end at all: nothing else
    // runs after a tab is shut, and the document would stay marked as open.
    expect(endForUnload).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('stops listening once the page is gone, so nothing fires for the next one', async () => {
    const wrapper = await show();
    wrapper.unmount();

    window.dispatchEvent(new Event('pagehide'));

    expect(endForUnload).not.toHaveBeenCalled();
  });

  it('closes the ordinary way when the page is left from inside the application', async () => {
    previewManager.isOpen = true;
    const wrapper = await show();

    wrapper.unmount();

    // Still in a browser that is going nowhere: the plugin gets the time it
    // needs rather than the one synchronous moment an unload gives it.
    expect(close).toHaveBeenCalledTimes(1);
    expect(endForUnload).not.toHaveBeenCalled();
  });
});
