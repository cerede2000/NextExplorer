import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

const search = vi.fn();

vi.mock('@/api', () => ({
  search: (...args) => search(...args),
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

const route = reactive({ path: '/browse', query: {}, params: {} });
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn() }),
  createRouter: () => ({
    beforeEach: vi.fn(),
    afterEach: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    install: vi.fn(),
  }),
  createWebHistory: vi.fn(),
  RouterLink: { template: '<a><slot /></a>' },
  RouterView: { template: '<div />' },
}));

import SpotlightSearch from './SpotlightSearch.vue';
import { useSpotlightStore } from '@/stores/spotlight';

/**
 * Typing does not start a search; it starts a second's wait for one. For that
 * second nothing was loading and nothing had been found, and the panel read
 * that as "no matches" — a search that had not run yet, reported as one that
 * had answered and come back empty. Someone who typed a word and read that
 * stopped waiting for results that were about to arrive.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      search: { searching: 'Searching…', noMatches: 'No matches found' },
      spotlight: { hintWithin: 'Search within', placeholder: 'Search', close: 'Close' },
      common: { in: 'in' },
      errors: { searchFailed: 'Search failed' },
    },
  },
});

const mountSpotlight = () =>
  mount(SpotlightSearch, {
    global: { plugins: [i18n], stubs: { FileIcon: true, MagnifyingGlassIcon: true } },
    attachTo: document.body,
  });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  search.mockReset();
  search.mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the moment after someone types', () => {
  const openWith = async (term) => {
    const wrapper = mountSpotlight();
    useSpotlightStore().open();
    await wrapper.vm.$nextTick();

    const input = wrapper.find('input');
    await input.setValue(term);
    return wrapper;
  };

  it('says it is searching, not that there is nothing', async () => {
    const wrapper = await openWith('Linting');

    // The debounce has not elapsed: no request has been made yet.
    expect(search).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Searching…');
    expect(wrapper.text()).not.toContain('No matches found');
  });

  it('goes on saying it while the request is in flight', async () => {
    let resolve;
    search.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );

    const wrapper = await openWith('Linting');
    await vi.advanceTimersByTimeAsync(1100);

    expect(search).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Searching…');
    expect(wrapper.text()).not.toContain('No matches found');

    resolve({ items: [] });
    await flushPromises();

    // Now it has an answer, and may say so.
    expect(wrapper.text()).toContain('No matches found');
  });

  it('stops waiting when the search box is emptied', async () => {
    const wrapper = await openWith('Linting');
    await wrapper.find('input').setValue('');
    await vi.advanceTimersByTimeAsync(1100);

    expect(wrapper.text()).not.toContain('Searching…');
  });
});
