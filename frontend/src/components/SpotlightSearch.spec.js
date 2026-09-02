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

/**
 * Typing `*.doc*`, then `*.docx`, then `*.doc*` sends three searches, and a
 * deep one runs for seconds. Nothing said which answer belonged to what was
 * being asked, so the panel showed whichever came back last — a list of `.doc`
 * files under a box reading `*.docx`, and no way to tell.
 */
describe('changing the search while one is running', () => {
  const typeInto = async (wrapper, term) => {
    await wrapper.find('input').setValue(term);
    await vi.advanceTimersByTimeAsync(400);
  };

  const openPanel = async () => {
    const wrapper = mountSpotlight();
    useSpotlightStore().open();
    await wrapper.vm.$nextTick();
    return wrapper;
  };

  it('shows the newest answer even when an older one comes back after it', async () => {
    const settle = {};
    search.mockImplementation(
      (path, term) =>
        new Promise((resolve) => {
          settle[term] = resolve;
        })
    );

    const wrapper = await openPanel();
    await typeInto(wrapper, '*.doc*');
    await typeInto(wrapper, '*.docx');

    // The newer search answers first, the older one afterwards — the order
    // that made the panel wrong.
    settle['*.docx']({ items: [{ name: 'budget.docx', path: 'Docs', isDirectory: false }] });
    await flushPromises();
    settle['*.doc*']({ items: [{ name: 'old.doc', path: 'Docs', isDirectory: false }] });
    await flushPromises();

    expect(wrapper.text()).toContain('budget.docx');
    expect(wrapper.text()).not.toContain('old.doc');
  });

  it('aborts the search it replaced, so the server stops looking', async () => {
    const signals = {};
    search.mockImplementation(
      (path, term, limit, options) =>
        new Promise((resolve) => {
          signals[term] = options?.signal;
          if (term === '*.docx') resolve({ items: [] });
        })
    );

    const wrapper = await openPanel();
    await typeInto(wrapper, '*.doc*');
    expect(signals['*.doc*']?.aborted).toBe(false);

    await typeInto(wrapper, '*.docx');
    expect(signals['*.doc*'].aborted).toBe(true);
  });

  it('does not report an abandoned search as a failure', async () => {
    search.mockImplementation((path, term) =>
      term === '*.doc*'
        ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        : Promise.resolve({ items: [] })
    );

    const wrapper = await openPanel();
    await typeInto(wrapper, '*.doc*');
    await typeInto(wrapper, '*.docx');
    await flushPromises();

    expect(wrapper.text()).not.toContain('Search failed');
  });
});
