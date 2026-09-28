import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * A terminal at an address of its own.
 *
 * The drawer can only ever show one, and it belongs to the window rather than to
 * anything in it — so two folders could not each have a shell open. Here a
 * terminal is a place: it has an address, so it has a tab, so there can be as many
 * as there are tabs.
 *
 * What this page owes is the folder: the address is the folder the shell starts
 * in, which is exactly what the drawer does when it is opened from a listing.
 */

const routePath = ref('Docs/2026');
vi.mock('vue-router', () => ({
  useRoute: () => ({
    get params() {
      return { path: routePath.value };
    },
  }),
}));

vi.mock('@/api', () => ({
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));

// The instance's name, for the browser tab's title.
vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({ state: { branding: { appName: 'Chez Benjy' } } }),
}));

// xterm reaches for a canvas jsdom does not have, and what it does with a socket
// is `TerminalSurface`'s own business. What is asked here is which folder it is
// handed, and that a change of folder builds another one rather than moving this
// one — a shell cannot change its mind about where it started.
const surface = vi.hoisted(() => ({ paths: [] }));
vi.mock('@/components/TerminalSurface.vue', () => ({
  default: {
    name: 'TerminalSurface',
    props: ['path', 'initialInput', 'active'],
    setup: (props) => {
      surface.paths.push(props.path);
      return () => null;
    },
  },
}));

import TerminalView from './TerminalView.vue';

const show = (path = 'Docs/2026') => {
  routePath.value = path;
  return mount(TerminalView, { global: { mocks: { $t: (key) => key } } });
};

beforeEach(() => {
  surface.paths.length = 0;
});

describe('a terminal at its own address', () => {
  it('starts the shell in the folder the address names', () => {
    show('Docs/2026');

    expect(surface.paths).toEqual(['Docs/2026']);
  });

  /** Nowhere in particular, which is where the home page opens one. */
  it('starts nowhere in particular when the address names no folder', () => {
    show('');

    expect(surface.paths).toEqual(['']);
  });

  it('says which folder it is in', () => {
    const wrapper = show('Docs/2026');

    expect(wrapper.text()).toContain('Docs/2026');
  });

  it('names the browser tab after the folder, and the instance', () => {
    show('Docs/2026');

    expect(window.document.title).toBe('titles.terminal — 2026 | Chez Benjy');
  });

  /**
   * A shell cannot change its mind about where it started, so a tab taken to
   * another folder gets another terminal rather than the same one moved.
   */
  it('builds another one when its tab is taken to another folder', async () => {
    const wrapper = show('Docs/2026');
    expect(surface.paths).toEqual(['Docs/2026']);

    routePath.value = 'Media';
    await wrapper.vm.$nextTick();

    // Built again, in the folder now asked for: the first is behind us.
    expect(surface.paths.length).toBeGreaterThan(1);
    expect(surface.paths.at(-1)).toBe('Media');
  });
});
