import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { createI18n } from 'vue-i18n';

const search = vi.fn();

vi.mock('@/api', () => ({
  search: (...args) => search(...args),
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

// Reactive, so the view's watch on the query fires the way it does in the app.
const route = reactive({ query: { q: 'Linting' } });
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn() }),
  // Something in the import chain builds a router at module load and hooks
  // guards onto it; it never runs here, but it has to exist.
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

import SearchResultsView from './SearchResultsView.vue';

/**
 * "No matches" is an answer, and the page used to give it before it had one:
 * from the first frame, and again whenever an earlier search came back while a
 * newer one was still running. Someone reading it saw a search that had run and
 * found nothing, and stopped waiting for the results that then arrived.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: { in: 'in' },
      search: {
        resultsFor: 'Results for {q}',
        searching: 'Searching…',
        noMatches: 'No matches found',
        line: 'line',
        openFolder: 'Open folder',
      },
      errors: { searchFailed: 'Search failed' },
    },
  },
});

const mountView = () =>
  mount(SearchResultsView, {
    global: { plugins: [i18n], stubs: { FileIcon: true } },
  });

/** A search that answers when we say so. */
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  search.mockReset();
  route.query = { q: 'Linting' };
});

describe('while a search is running', () => {
  it('never says there are no matches', async () => {
    const pending = deferred();
    search.mockReturnValue(pending.promise);

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('Searching…');
    expect(wrapper.text()).not.toContain('No matches found');

    pending.resolve({ items: [{ name: 'a.js', path: 'src', kind: 'file' }] });
    await flushPromises();

    expect(wrapper.text()).toContain('a.js');
    expect(wrapper.text()).not.toContain('No matches found');
  });

  it('says so once it has finished with nothing', async () => {
    search.mockResolvedValue({ items: [] });

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('No matches found');
  });
});

describe('when one search overtakes another', () => {
  // The older request finishing must not clear the waiting state, or the page
  // announces an empty answer while the search being awaited is still running.
  it('keeps waiting for the one that matters', async () => {
    const first = deferred();
    const second = deferred();
    search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const wrapper = mountView();
    await flushPromises();

    // The view watches the query, so changing it starts the second search.
    route.query = { q: 'Linting more' };
    await flushPromises();

    first.resolve({ items: [] });
    await flushPromises();

    expect(wrapper.text()).not.toContain('No matches found');
  });

  it('shows the newest answer, not the one that came back last', async () => {
    const first = deferred();
    search.mockReturnValueOnce(first.promise).mockResolvedValue({
      items: [{ name: 'new.js', path: 'src', kind: 'file' }],
    });

    const wrapper = mountView();
    await flushPromises();

    first.resolve({ items: [{ name: 'stale.js', path: 'src', kind: 'file' }] });
    await flushPromises();

    expect(wrapper.text()).toContain('stale.js');
  });
});
