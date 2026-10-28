import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';

/**
 * One folder's toolbar, and the two questions it answers before drawing.
 *
 * Which folder it is on decides whether there is anything to offer at all —
 * the list of volumes is a page about nothing in particular, so the New
 * button, the sort, the view switcher and refreshing are all left out. And
 * what the location allows decides whether anything can be made in it.
 *
 * Both were read from the address and from the access metadata, and neither
 * was held by a test: the file sat at eight per cent of its statements and
 * none of its branches. The share's root is the case that already went wrong
 * once — its address carries the share in a parameter of its own, so the path
 * beside it is empty, and reading "empty path" as "the volumes list" took the
 * whole toolbar away from a visitor who could write in that share.
 */

const route = reactive({ params: { path: '' }, query: {}, name: 'browse' });
const push = vi.fn(async () => {});
let shareToken = '';

let settings;
let auth;
let fileStore;
let actions;
const isTouchDevice = ref(false);

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push }),
}));
vi.mock('@/router/shareToken', () => ({ shareTokenOf: () => shareToken }));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => settings }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => fileStore }));
vi.mock('@/composables/fileActions', () => ({ useFileActions: () => actions }));
vi.mock('@/composables/useInputMode', () => ({ useInputMode: () => ({ isTouchDevice }) }));
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));

/** The children are other components' business; this one is about what it shows. */
const stub = vi.hoisted(() => (name) => ({
  default: { name, render: () => null },
}));
vi.mock('@/components/NavButtons.vue', () => stub('NavButtonsStub'));
vi.mock('@/components/BreadCrumb.vue', () => stub('BreadCrumbStub'));
vi.mock('@/components/MenuItemInfo.vue', () => stub('MenuItemInfoStub'));
vi.mock('@/components/MenuSortBy.vue', () => stub('MenuSortByStub'));
vi.mock('@/components/ViewMode.vue', () => stub('ViewModeStub'));
vi.mock('@/components/PhotoSizeControl.vue', () => stub('PhotoSizeControlStub'));
vi.mock('@/components/MenuShare.vue', () => stub('MenuShareStub'));
vi.mock('@/components/CreateNew.vue', () => stub('CreateNewStub'));
vi.mock('@/components/InlineQuickActions.vue', () => stub('InlineQuickActionsStub'));

import FolderViewToolbar from './FolderViewToolbar.vue';

const mountToolbar = () =>
  mount(FolderViewToolbar, {
    global: {
      // The template asks for the global `$t`, not the composable.
      mocks: { $t: (key) => key },
      stubs: { ArrowDownTrayIcon: true, ArrowPathIcon: true, HomeIcon: true },
    },
  });

/** The one the reader presses to start selecting, which only a finger needs. */
const selectButton = (wrapper) =>
  wrapper.findAll('button').find((button) => button.text() === 'common.select');

beforeEach(() => {
  route.params.path = 'Documents';
  shareToken = '';
  isTouchDevice.value = false;
  push.mockClear();
  settings = reactive({ view: 'list' });
  auth = reactive({ isAuthenticated: true, isGuest: false });
  fileStore = reactive({
    currentPathData: null,
    selectionMode: false,
    refresh: vi.fn(async () => {}),
    toggleSelectionMode: vi.fn(),
  });
  actions = { canDownloadCurrentFolder: ref(true) };
});

describe('where the toolbar is standing', () => {
  it('offers nothing on the list of volumes, which is not a folder', () => {
    route.params.path = '';

    const wrapper = mountToolbar();

    expect(wrapper.findComponent({ name: 'CreateNewStub' }).exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'MenuSortByStub' }).exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'ViewModeStub' }).exists()).toBe(false);
  });

  /**
   * The case that went wrong: a share's address carries the share in a
   * parameter of its own, so at its root the path beside it is empty. Reading
   * that as the volumes list left a visitor who could write in the share with
   * nothing to write with until they walked into a subfolder.
   */
  it('is a folder at the root of a share, where the path is empty', () => {
    route.params.path = '';
    shareToken = 'tok';

    const wrapper = mountToolbar();

    expect(wrapper.findComponent({ name: 'CreateNewStub' }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'MenuSortByStub' }).exists()).toBe(true);
  });

  it('reads a path given in parts as one path', () => {
    route.params.path = ['Documents', '2026'];

    expect(mountToolbar().findComponent({ name: 'MenuSortByStub' }).exists()).toBe(true);
  });
});

describe('what may be made here', () => {
  it('is what the location says, when the location says', () => {
    fileStore.currentPathData = {
      canCreateFolder: false,
      canCreateFile: false,
      canUpload: false,
    };

    expect(mountToolbar().findComponent({ name: 'CreateNewStub' }).exists()).toBe(false);
  });

  it('is offered when the location allows any one of the three', () => {
    fileStore.currentPathData = { canCreateFolder: false, canCreateFile: false, canUpload: true };

    expect(mountToolbar().findComponent({ name: 'CreateNewStub' }).exists()).toBe(true);
  });

  /** Older servers send no access metadata, and an account is trusted without it. */
  it('is offered to an account when the location says nothing', () => {
    fileStore.currentPathData = null;

    expect(mountToolbar().findComponent({ name: 'CreateNewStub' }).exists()).toBe(true);
  });

  /** A visitor is not, because silence is not permission for somebody with no account. */
  it('is refused to a visitor when the location says nothing', () => {
    fileStore.currentPathData = null;
    auth.isAuthenticated = false;
    auth.isGuest = true;

    expect(mountToolbar().findComponent({ name: 'CreateNewStub' }).exists()).toBe(false);
  });
});

describe('the button that starts a selection', () => {
  /**
   * It exists for a finger, which has no second click to select with. A
   * pointer selects by clicking, so offering the mode there is a step that
   * buys nothing.
   */
  it('is not shown where there is a pointer', () => {
    expect(selectButton(mountToolbar())).toBeUndefined();
  });

  it('is shown where the reader is using a finger', () => {
    isTouchDevice.value = true;

    expect(selectButton(mountToolbar())).toBeDefined();
  });

  it('is not shown on the list of volumes even with a finger', () => {
    isTouchDevice.value = true;
    route.params.path = '';

    expect(selectButton(mountToolbar())).toBeUndefined();
  });

  it('turns the mode on, and lets go of what was held when it goes off', async () => {
    isTouchDevice.value = true;
    const wrapper = mountToolbar();

    await selectButton(wrapper).trigger('click');

    expect(fileStore.toggleSelectionMode).toHaveBeenCalledWith({ clearOnDisable: true });
  });

  it('says it is done once the mode is on', () => {
    isTouchDevice.value = true;
    fileStore.selectionMode = true;

    const wrapper = mountToolbar();

    expect(wrapper.findAll('button').some((b) => b.text() === 'common.done')).toBe(true);
  });
});

describe('asking the folder again', () => {
  const refreshButton = (wrapper) =>
    wrapper.findAll('button').find((button) => button.attributes('title') === 'nav.refresh');

  it('re-reads the listing', async () => {
    const wrapper = mountToolbar();

    await refreshButton(wrapper).trigger('click');

    expect(fileStore.refresh).toHaveBeenCalledTimes(1);
  });

  /** A second press while the first is still out asks nothing: one is enough. */
  it('does not stack while one is still out', async () => {
    let settle;
    fileStore.refresh = vi.fn(() => new Promise((resolve) => (settle = resolve)));
    const wrapper = mountToolbar();

    await refreshButton(wrapper).trigger('click');
    await refreshButton(wrapper).trigger('click');
    expect(fileStore.refresh).toHaveBeenCalledTimes(1);

    settle();
  });
});
