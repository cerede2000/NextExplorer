import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

/**
 * The Terminal entry in the sidebar.
 *
 * With tabs on a terminal is a place like any other: it takes a tab of its own,
 * and there can be as many as there are tabs. The drawer could never do that — it
 * belongs to the window rather than to anything in it, so opening a second shell
 * meant losing the first. Without tabs the drawer is still the only way to show
 * one, and it opens exactly as it always has.
 *
 * Where the shell starts is the same question in both: the folder on screen, or
 * nowhere in particular on the home page.
 */

const terminalStore = { toggle: vi.fn(), isOpen: false };
vi.mock('@/stores/terminal', () => ({ useTerminalStore: () => terminalStore }));

const appTabs = { enabled: false };
const openInTab = vi.fn();
vi.mock('@/composables/tabNavigation', () => ({
  useTabNavigation: () => ({
    get tabs() {
      return appTabs;
    },
    open: (...args) => openInTab(...args),
  }),
}));

const auth = { currentUser: { roles: ['admin'] } };
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));

const fileStore = { currentPath: 'Docs/2026' };
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => fileStore }));

const route = { name: 'FolderView' };
vi.mock('vue-router', () => ({ useRoute: () => route }));

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));

import TerminalMenu from './TerminalMenu.vue';

const show = () => mount(TerminalMenu, { global: { mocks: { $t: (key) => key } } });
const terminalButton = (wrapper) =>
  wrapper.findAll('button').find((button) => button.text().includes('terminal'));

beforeEach(() => {
  terminalStore.toggle.mockClear();
  openInTab.mockClear();
  appTabs.enabled = false;
  auth.currentUser = { roles: ['admin'] };
  fileStore.currentPath = 'Docs/2026';
  route.name = 'FolderView';
});

describe('opening a terminal from the sidebar', () => {
  it('opens the drawer on the folder on screen, with tabs off', async () => {
    const wrapper = show();

    await terminalButton(wrapper).trigger('click');

    expect(terminalStore.toggle).toHaveBeenCalledWith('Docs/2026');
    expect(openInTab).not.toHaveBeenCalled();
  });

  it('opens a tab of its own instead, with tabs on', async () => {
    appTabs.enabled = true;
    const wrapper = show();

    await terminalButton(wrapper).trigger('click');

    expect(openInTab).toHaveBeenCalledWith('/terminal/Docs/2026', { own: true });
    expect(terminalStore.toggle).not.toHaveBeenCalled();
  });

  /** Nowhere in particular: the home page is not a folder to start a shell in. */
  it('starts nowhere in particular from the home page', async () => {
    appTabs.enabled = true;
    route.name = 'HomeView';
    const wrapper = show();

    await terminalButton(wrapper).trigger('click');

    expect(openInTab).toHaveBeenCalledWith('/terminal', { own: true });
  });

  it('writes a folder holding a space the way an address is written', async () => {
    appTabs.enabled = true;
    fileStore.currentPath = 'Docs/data set';
    const wrapper = show();

    await terminalButton(wrapper).trigger('click');

    expect(openInTab).toHaveBeenCalledWith('/terminal/Docs/data%20set', { own: true });
  });

  /** A terminal is an administrator's, whichever way it is shown. */
  it('is not offered to anybody else', () => {
    auth.currentUser = { roles: ['user'] };
    const wrapper = show();

    expect(terminalButton(wrapper)).toBeUndefined();
  });
});
