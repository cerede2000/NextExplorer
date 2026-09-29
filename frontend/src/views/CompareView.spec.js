import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * Two or three files, side by side.
 *
 * The alignment has its own suite; what is asked here is the part a reader actually
 * does with a comparison. Step through the differences without hunting for them.
 * Take one side's version of a difference over the other's. Save.
 *
 * The lines are the state and everything else is worked out from them, which is what
 * makes taking a block across three lines of code rather than a bookkeeping exercise
 * — so what is worth asserting is that after a copy the difference is *gone*, the
 * counts have moved, and the file that would be written is the file the reader now
 * sees.
 */

const route = reactive({ fullPath: '/compare?paths=Docs%2Fa.txt&paths=Docs%2Fb.txt', query: {} });
const push = vi.fn();
const replace = vi.fn();
const leaveGuards = [];
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push, replace }),
  onBeforeRouteLeave: (guard) => leaveGuards.push(guard),
}));

const api = vi.hoisted(() => ({
  fetchFileContent: vi.fn(),
  saveFileContent: vi.fn(async () => ({ success: true })),
}));
// An earlier version is read through its own door.
const versionText = vi.hoisted(() => vi.fn(async () => ({ content: '' })));
vi.mock('@/api', () => ({
  fetchFileContent: (...args) => api.fetchFileContent(...args),
  saveFileContent: (...args) => api.saveFileContent(...args),
  getVersionText: (...args) => versionText(...args),
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('@/composables/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('@/composables/tabNavigation', () => ({
  useTabNavigation: () => ({ tabs: { enabled: true }, closeOwn: () => false }),
}));
const appTabs = vi.hoisted(() => ({ activeId: 'tab-1', tabs: [{ id: 'tab-1' }, { id: 'tab-9' }] }));
vi.mock('@/stores/tabs', () => ({ useTabsStore: () => appTabs }));
vi.mock('@/stores/tabLoading', () => ({
  useTabLoadingStore: () => ({ begin: () => () => {} }),
}));
/**
 * A question this tab leaves for whoever closes it. Closing is the one gesture that
 * really loses lines copied across: coming back to a tab keeps them.
 */
const guards = vi.hoisted(() => ({ asked: [], guard: vi.fn(), release: vi.fn() }));
vi.mock('@/stores/tabGuards', () => ({
  useTabGuardsStore: () => ({
    guard: (id, ask) => {
      guards.guard(id, ask);
      guards.asked.push({ id, ask });
      return () => {
        guards.asked = guards.asked.filter((one) => one.ask !== ask);
      };
    },
    release: guards.release,
  }),
}));
const notifications = vi.hoisted(() => ({ addNotification: vi.fn() }));
vi.mock('@/stores/notifications', () => ({ useNotificationsStore: () => notifications }));

/**
 * What a tab is in the middle of comparing, held between two glances. A stand-in:
 * the rule about *which* address a comparison belongs to is the store's, and
 * `stores/compareSessions.spec.js` holds it to that.
 */
const kept = vi.hoisted(() => new Map());
vi.mock('@/stores/compareSessions', () => ({
  useCompareSessionsStore: () => ({
    keep: (key, address, state) => kept.set(key, { ...state, address }),
    forget: (key) => kept.delete(key),
    sessionFor: (key, address) => {
      const held = kept.get(key);
      return held && held.address === address ? held : null;
    },
  }),
}));

import CompareView from './CompareView.vue';

const open = async (files, paths = Object.keys(files)) => {
  api.fetchFileContent.mockImplementation(async (path) => ({ content: files[path] }));
  route.query = { paths };
  route.fullPath = `/compare?${paths.map((one) => `paths=${one}`).join('&')}`;
  const wrapper = mount(CompareView, { global: { mocks: { $t: (key) => key } } });
  await flushPromises();
  await flushPromises();
  return wrapper;
};

const rows = (wrapper) => wrapper.findAll('[data-test="compare-row"]');

beforeEach(() => {
  kept.clear();
  guards.asked = [];
  guards.guard.mockClear();
  appTabs.activeId = 'tab-1';
  appTabs.tabs = [{ id: 'tab-1' }, { id: 'tab-9' }];
  push.mockClear();
  replace.mockClear();
  leaveGuards.length = 0;
  api.saveFileContent.mockClear();
  versionText.mockClear();
  api.saveFileContent.mockResolvedValue({ success: true });
  notifications.addNotification.mockClear();
});

describe('a comparison of two files', () => {
  it('counts the differences it found', async () => {
    const wrapper = await open({
      'a.txt': 'one\ntwo\nthree',
      'b.txt': 'one\nTWO\nthree',
    });

    // The bar shows the number; the sentence is in the title, where it is read by
    // whoever asks rather than by everybody at every width.
    expect(wrapper.get('[data-test="compare-count"]').attributes('title')).toContain('"count":1');
  });

  it('says so when the two files are the same', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\ntwo' });

    expect(wrapper.find('[data-test="compare-identical"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="compare-next"]').attributes('disabled')).toBeDefined();
  });

  it('draws every line of both files, aligned', async () => {
    const wrapper = await open({ 'a.txt': 'one\nthree', 'b.txt': 'one\ntwo\nthree' });

    expect(rows(wrapper)).toHaveLength(3);
    expect(rows(wrapper)[1].attributes('data-kind')).toBe('added');
  });

  it('marks the part of a changed line that differs', async () => {
    const wrapper = await open({
      'a.txt': '/etc/sites/a.conf',
      'b.txt': '/etc/sites/b.conf',
    });

    const marked = wrapper.findAll('[data-test="compare-inline"]').map((node) => node.text());
    expect(marked).toEqual(['a', 'b']);
  });
});

describe('stepping through the differences', () => {
  const twoDifferences = () => open({ 'a.txt': 'a\nb\nc\nd\ne', 'b.txt': 'a\nB\nc\nD\ne' });

  it('starts on none, and the first step is the first', async () => {
    const wrapper = await twoDifferences();
    expect(wrapper.findAll('[data-current="true"]')).toHaveLength(0);

    await wrapper.get('[data-test="compare-next"]').trigger('click');

    const current = wrapper.findAll('[data-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].text()).toContain('B');
  });

  it('walks on to the next', async () => {
    const wrapper = await twoDifferences();

    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    expect(wrapper.get('[data-current="true"]').text()).toContain('D');
  });

  /**
   * A comparison is read in circles: somebody on the last difference pressing
   * "next" means "start again", and a button that does nothing is one they press
   * twice to be sure.
   */
  it('comes round again from the last', async () => {
    const wrapper = await twoDifferences();

    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    expect(wrapper.get('[data-current="true"]').text()).toContain('B');
  });

  it('walks backwards too, round the other way', async () => {
    const wrapper = await twoDifferences();

    await wrapper.get('[data-test="compare-previous"]').trigger('click');

    expect(wrapper.get('[data-current="true"]').text()).toContain('D');
  });

  /** F8 and F7, which is what anybody arriving here will try first. */
  it('walks them from the keyboard', async () => {
    const wrapper = await twoDifferences();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8' }));
    await flushPromises();

    expect(wrapper.get('[data-current="true"]').text()).toContain('B');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7' }));
    await flushPromises();

    expect(wrapper.get('[data-current="true"]').text()).toContain('D');
  });

  it('walks them with alt and the arrows, for a keyboard without those keys', async () => {
    const wrapper = await twoDifferences();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }));
    await flushPromises();

    expect(wrapper.get('[data-current="true"]').text()).toContain('B');
  });
});

describe('taking one side over the other', () => {
  it('replaces the line on the right, and the difference is gone', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo\nthree', 'b.txt': 'one\nTWO\nthree' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="compare-identical"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-test="compare-row"]')).toHaveLength(3);
  });

  it('replaces the line on the left when taken the other way', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo\nthree', 'b.txt': 'one\nTWO\nthree' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    await wrapper.get('[data-test="compare-copy-back-0"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="compare-save-0"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith('a.txt', 'one\nTWO\nthree');
  });

  /** A whole run is one difference, and taking it across takes all of it. */
  it('takes a run of lines across in one go', async () => {
    const wrapper = await open({ 'a.txt': 'a\nb\nc\nd', 'b.txt': 'a\nX\nY\nd' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="compare-save-1"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith('b.txt', 'a\nb\nc\nd');
  });

  /** A line only one side has goes where it can mean something: after the one above. */
  it('takes a line the other side has not got at all', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo\nthree', 'b.txt': 'one\nthree' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="compare-save-1"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith('b.txt', 'one\ntwo\nthree');
  });

  it('takes away a line the other side has not got', async () => {
    const wrapper = await open({ 'a.txt': 'one\nthree', 'b.txt': 'one\ntwo\nthree' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="compare-save-1"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith('b.txt', 'one\nthree');
  });

  it('offers nothing to take across before a difference has been chosen', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });

    expect(
      wrapper.get('[data-test="compare-copy-forward-0"]').attributes('disabled')
    ).toBeDefined();
  });
});

describe('saving a side that has been changed', () => {
  /** Not there at all until there is: a row of greyed buttons naming files is what
   * made this bar wrap in the first place. */
  it('is offered only once something has been taken across', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });

    expect(wrapper.find('[data-test="compare-save-1"]').exists()).toBe(false);

    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');

    expect(wrapper.find('[data-test="compare-save-1"]').exists()).toBe(true);
  });

  /**
   * A CRLF file saved with newlines is a file where every line differs from what it
   * was, and nobody reviewing that change will thank anybody for it.
   */
  it('writes the file back the way it ended its lines', async () => {
    const wrapper = await open({ 'a.txt': 'one\r\ntwo', 'b.txt': 'one\r\nTWO' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-test="compare-save-1"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith('b.txt', 'one\r\ntwo');
  });

  it('says so when the write is refused, and stays changed', async () => {
    api.saveFileContent.mockRejectedValue(new Error('read only'));
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-test="compare-save-1"]').trigger('click');
    await flushPromises();

    expect(notifications.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );
    expect(wrapper.get('[data-test="compare-save-1"]').attributes('disabled')).toBeUndefined();
  });

  /**
   * There is no submit button to forget to press: a comparison is left by clicking a
   * tab, and lines taken across exist nowhere but this window until they are saved.
   */
  it('asks before leaving with something not saved', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      expect(leaveGuards.map((guard) => guard())).toEqual([false]);
      expect(confirm).toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  /**
   * Another tab coming forward is not leaving: the comparison is handed to the tab and
   * comes back with it, lines and place and all. Asking there asked about something
   * that was not going to happen — and the answer stopped the reader leaving their own
   * comparison.
   */
  it('does not ask when another tab is coming forward', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    appTabs.activeId = 'tab-9';

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      expect(leaveGuards.map((guard) => guard())).toEqual([true]);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it('does not ask when nothing was taken across', async () => {
    await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      expect(leaveGuards.map((guard) => guard())).toEqual([true]);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });
});

/**
 * What a tab was in the middle of, put straight back.
 *
 * The screen is a page, and a page is unmounted the moment another tab comes forward
 * — so a glance at another tab read both files again, redrew everything and lost the
 * reader's place. Worse: lines taken across and not yet saved exist nowhere but this
 * screen, so they went too, silently, for a click that never said discard.
 */
describe('a comparison tab coming back', () => {
  const leaveAndReturn = async (wrapper) => {
    appTabs.activeId = 'tab-9';
    wrapper.unmount();
    appTabs.activeId = 'tab-1';
  };

  it('reads neither file again', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });
    await leaveAndReturn(wrapper);
    api.fetchFileContent.mockClear();

    const back = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });

    expect(api.fetchFileContent).not.toHaveBeenCalled();
    expect(back.find('[data-test="compare-loading"]').exists()).toBe(false);
    expect(back.get('[data-test="compare-count"]').attributes('title')).toContain('"count":1');
  });

  /** The lines exist nowhere else: losing them is losing somebody's work. */
  it('still holds the lines taken across and not saved', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    await leaveAndReturn(wrapper);

    const back = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });

    expect(back.find('[data-test="compare-identical"]').exists()).toBe(true);
    expect(back.get('[data-test="compare-save-1"]').attributes('disabled')).toBeUndefined();

    await back.get('[data-test="compare-save-1"]').trigger('click');
    await flushPromises();
    expect(api.saveFileContent).toHaveBeenCalledWith('b.txt', 'one\ntwo');
  });

  it('comes back to the difference the reader was on', async () => {
    const wrapper = await open({ 'a.txt': 'a\nb\nc\nd\ne', 'b.txt': 'a\nB\nc\nD\ne' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await leaveAndReturn(wrapper);

    const back = await open({ 'a.txt': 'a\nb\nc\nd\ne', 'b.txt': 'a\nB\nc\nD\ne' });

    expect(back.get('[data-current="true"]').text()).toContain('D');
  });

  /**
   * A tab taken to another comparison has nothing to do with the lines of the
   * previous one, and answering with them would put one pair of files' work into
   * another pair.
   */
  it('reads the files when the tab was taken to another comparison', async () => {
    const wrapper = await open({ 'a.txt': 'one', 'b.txt': 'ONE' });
    await leaveAndReturn(wrapper);
    api.fetchFileContent.mockClear();

    await open({ 'c.txt': 'two', 'd.txt': 'TWO' }, ['c.txt', 'd.txt']);

    expect(api.fetchFileContent).toHaveBeenCalledWith('c.txt');
  });

  /** Still the tab in front, so the address changed under it: nothing to keep. */
  it('keeps nothing when the same tab is taken somewhere else', async () => {
    const wrapper = await open({ 'a.txt': 'one', 'b.txt': 'ONE' });
    wrapper.unmount();
    api.fetchFileContent.mockClear();

    await open({ 'a.txt': 'one', 'b.txt': 'ONE' });

    expect(api.fetchFileContent).toHaveBeenCalled();
  });
});

/**
 * A file against one of its own earlier versions.
 *
 * Read-only on the version's side: there is nothing to write a version back to, and
 * offering it would be offering to change something that has already happened. Taking
 * lines *out* of it is the whole point.
 */
describe('a comparison with an earlier version', () => {
  const withVersion = async () => {
    api.fetchFileContent.mockImplementation(async () => ({ content: 'one\nNOW' }));
    versionText.mockImplementation(async () => ({ content: 'one\nTHEN', name: 'notes.txt' }));
    route.query = { paths: ['Docs/notes.txt', 'Docs/notes.txt'], versions: ['v7', ''] };
    route.fullPath = '/compare?paths=Docs%2Fnotes.txt&paths=Docs%2Fnotes.txt&versions=v7&versions=';
    const wrapper = mount(CompareView, { global: { mocks: { $t: (key) => key } } });
    await flushPromises();
    await flushPromises();
    return wrapper;
  };

  it('reads the version through its own door, and says which side it is', async () => {
    const wrapper = await withVersion();

    expect(versionText).toHaveBeenCalledWith('Docs/notes.txt', 'v7');
    expect(wrapper.get('[data-test="compare-names"]').text()).toContain('compare.versionOf');
  });

  it('offers no way to write into the version', async () => {
    const wrapper = await withVersion();
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    // Forward is left-to-right, and the version is the left: that one is refused.
    expect(wrapper.get('[data-test="compare-copy-back-0"]').attributes('disabled')).toBeDefined();
    expect(
      wrapper.get('[data-test="compare-copy-forward-0"]').attributes('disabled')
    ).toBeUndefined();
  });

  it('takes the version’s line over what the file says now', async () => {
    const wrapper = await withVersion();
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="compare-save-1"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith('Docs/notes.txt', 'one\nTHEN');
  });

  it('never writes the version itself back', async () => {
    const wrapper = await withVersion();
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');
    await flushPromises();

    // The file took a line from the version, so the file has a save button; the
    // version never does, whatever happens.
    expect(wrapper.find('[data-test="compare-save-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="compare-save-0"]').exists()).toBe(false);
  });
});

/**
 * Looking for something, and putting something else in its place.
 *
 * A comparison is read for a reason, and the reason is usually a name: which of these
 * two files still says the old server, and what does the other one say instead. So the
 * search is how somebody gets to the line they came for, and the replacement is how
 * they leave.
 */
describe('searching and replacing', () => {
  const opened = async () => {
    const wrapper = await open({
      'a.txt': 'server = old\nport = 80\nname = old',
      'b.txt': 'server = old\nport = 8080\nname = new',
    });
    await wrapper.get('[data-test="compare-search-toggle"]').trigger('click');
    return wrapper;
  };

  it('counts what it found, everywhere by default', async () => {
    const wrapper = await opened();

    await wrapper.get('[data-test="compare-search-query"]').setValue('old');

    // Twice on the left, once on the right.
    expect(wrapper.get('[data-test="compare-search-count"]').attributes('data-count')).toBe('3');
  });

  it('marks what it found, and the one being read', async () => {
    const wrapper = await opened();
    await wrapper.get('[data-test="compare-search-query"]').setValue('old');

    await wrapper.get('[data-test="compare-search-next"]').trigger('click');

    expect(wrapper.get('[data-test="compare-search-count"]').text()).toContain('"index":1');
  });

  /** In this file, in that one, or in all of them — the question people ask. */
  it('looks in one side only when told to', async () => {
    const wrapper = await opened();
    await wrapper.get('[data-test="compare-search-query"]').setValue('old');

    await wrapper.get('[data-test="compare-search-scope"]').setValue('1');

    expect(wrapper.get('[data-test="compare-search-count"]').attributes('data-count')).toBe('1');
  });

  it('minds the case when asked to', async () => {
    const wrapper = await opened();
    await wrapper.get('[data-test="compare-search-query"]').setValue('OLD');
    expect(wrapper.get('[data-test="compare-search-count"]').attributes('data-count')).toBe('3');

    await wrapper.get('[data-test="compare-search-case"]').setValue(true);

    expect(wrapper.get('[data-test="compare-search-count"]').text()).toContain('compare.noMatch');
  });

  it('replaces the one being read, and nothing else', async () => {
    const wrapper = await opened();
    await wrapper.get('[data-test="compare-search-query"]').setValue('old');
    await wrapper.get('[data-test="compare-search-replacement"]').setValue('new');
    await wrapper.get('[data-test="compare-search-next"]').trigger('click');

    await wrapper.get('[data-test="compare-replace-one"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="compare-save-0"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith(
      'a.txt',
      'server = new\nport = 80\nname = old'
    );
  });

  it('replaces every one in the side it was told to', async () => {
    const wrapper = await opened();
    await wrapper.get('[data-test="compare-search-query"]').setValue('old');
    await wrapper.get('[data-test="compare-search-replacement"]').setValue('new');
    await wrapper.get('[data-test="compare-search-scope"]').setValue('0');

    await wrapper.get('[data-test="compare-replace-all"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="compare-save-0"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith(
      'a.txt',
      'server = new\nport = 80\nname = new'
    );
  });

  /**
   * Right to left within a line, so replacing one does not move the ones not yet
   * replaced — the classic way to lose the last match on a line.
   */
  it('replaces every one on a line, whatever the lengths', async () => {
    const wrapper = await open({ 'a.txt': 'a a a', 'b.txt': 'b' });
    await wrapper.get('[data-test="compare-search-toggle"]').trigger('click');
    await wrapper.get('[data-test="compare-search-query"]').setValue('a');
    await wrapper.get('[data-test="compare-search-replacement"]').setValue('LONGER');
    await wrapper.get('[data-test="compare-search-scope"]').setValue('0');

    await wrapper.get('[data-test="compare-replace-all"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="compare-save-0"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith('a.txt', 'LONGER LONGER LONGER');
  });

  /** A match folded away is a match somebody would swear was not there. */
  it('unfolds when the search opens', async () => {
    const long = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n');
    const wrapper = await open({ 'a.txt': long, 'b.txt': `${long}\nextra` });
    expect(wrapper.get('[data-test="compare-fold"]').attributes('aria-pressed')).toBe('true');

    await wrapper.get('[data-test="compare-search-toggle"]').trigger('click');

    expect(wrapper.get('[data-test="compare-fold"]').attributes('aria-pressed')).toBe('false');
  });

  it('never writes into a side that is a version', async () => {
    api.fetchFileContent.mockImplementation(async () => ({ content: 'old' }));
    versionText.mockImplementation(async () => ({ content: 'old', name: 'notes.txt' }));
    route.query = { paths: ['notes.txt', 'notes.txt'], versions: ['v7', ''] };
    route.fullPath = '/compare?paths=notes.txt&paths=notes.txt&versions=v7&versions=';
    const wrapper = mount(CompareView, { global: { mocks: { $t: (key) => key } } });
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-test="compare-search-toggle"]').trigger('click');
    await wrapper.get('[data-test="compare-search-query"]').setValue('old');
    await wrapper.get('[data-test="compare-search-replacement"]').setValue('new');

    await wrapper.get('[data-test="compare-replace-all"]').trigger('click');
    await flushPromises();

    // Only the file has a save button; the version was left exactly as it was.
    expect(wrapper.find('[data-test="compare-save-0"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="compare-save-1"]').exists()).toBe(true);
  });
});

/**
 * One line changed by hand.
 *
 * Taking a whole difference across is the common gesture, but not every fix is one
 * side or the other: sometimes the answer is neither, and walking to the editor and
 * back to type one word is a walk nobody should have to make.
 */
describe('editing a line in place', () => {
  it('takes what was typed, and the side is then worth saving', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });

    await wrapper.findAll('[data-test="compare-row"]')[1].findAll('span')[1].trigger('dblclick');
    const field = wrapper.get('[data-test="compare-edit-0"]');
    await field.setValue('typed by hand');
    await field.trigger('keydown.enter');
    await flushPromises();

    await wrapper.get('[data-test="compare-save-0"]').trigger('click');
    await flushPromises();
    expect(api.saveFileContent).toHaveBeenCalledWith('a.txt', 'one\ntyped by hand');
  });

  it('leaves the line alone when the edit is called off', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });

    await wrapper.findAll('[data-test="compare-row"]')[1].findAll('span')[1].trigger('dblclick');
    const field = wrapper.get('[data-test="compare-edit-0"]');
    await field.setValue('never mind');
    await field.trigger('keydown.esc');
    await flushPromises();

    expect(wrapper.find('[data-test="compare-save-0"]').exists()).toBe(false);
  });

  /** There is nothing to write a version back to. */
  it('cannot be started on a version', async () => {
    api.fetchFileContent.mockImplementation(async () => ({ content: 'one\nNOW' }));
    versionText.mockImplementation(async () => ({ content: 'one\nTHEN', name: 'notes.txt' }));
    route.query = { paths: ['notes.txt', 'notes.txt'], versions: ['v7', ''] };
    route.fullPath = '/compare?paths=notes.txt&paths=notes.txt&versions=v7&versions=';
    const wrapper = mount(CompareView, { global: { mocks: { $t: (key) => key } } });
    await flushPromises();
    await flushPromises();

    await wrapper.findAll('[data-test="compare-row"]')[1].findAll('span')[1].trigger('dblclick');

    expect(wrapper.find('[data-test="compare-edit-0"]').exists()).toBe(false);
  });
});

/**
 * Where the differences are, down the whole file.
 *
 * A scrollbar says where you are; this says where you are going — and it is one click
 * from here to there, which on a file of two thousand lines is the difference between
 * reading a comparison and hunting through one.
 */
describe('the map of the differences', () => {
  it('has a mark for each of them, and none when there are none', async () => {
    const two = await open({ 'a.txt': 'a\nb\nc\nd\ne', 'b.txt': 'a\nB\nc\nD\ne' });
    expect(two.findAll('[data-test^="compare-map-mark-"]')).toHaveLength(2);

    const same = await open({ 'a.txt': 'a\nb', 'b.txt': 'a\nb' });
    expect(same.find('[data-test="compare-map"]').exists()).toBe(false);
  });

  it('goes to the difference the mark stands for', async () => {
    const wrapper = await open({ 'a.txt': 'a\nb\nc\nd\ne', 'b.txt': 'a\nB\nc\nD\ne' });

    await wrapper.get('[data-test="compare-map-mark-1"]').trigger('click');

    expect(wrapper.get('[data-current="true"]').text()).toContain('D');
  });
});

/**
 * Which file is on the left is the reader's business, not the order they happened to
 * click in — and with a version in the comparison it is the difference between reading
 * "what happened since" and reading it backwards.
 */
describe('putting the two sides the other way round', () => {
  it('swaps them, and says so in the address', async () => {
    const wrapper = await open({ 'a.txt': 'one', 'b.txt': 'ONE' });

    await wrapper.get('[data-test="compare-swap-0"]').trigger('click');

    expect(wrapper.get('[data-test="compare-names"]').text()).toBe('b.txt ↔ a.txt');
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/compare?paths=b.txt&paths=a.txt');
  });

  /** What the tab is holding must not be lost because the sides moved. */
  it('keeps the lines that were taken across', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });
    await wrapper.get('[data-test="compare-next"]').trigger('click');
    await wrapper.get('[data-test="compare-copy-forward-0"]').trigger('click');

    await wrapper.get('[data-test="compare-swap-0"]').trigger('click');

    // b.txt is on the left now, and it is the one that was changed.
    expect(wrapper.find('[data-test="compare-save-0"]').exists()).toBe(true);
  });
});

describe('a long file', () => {
  const long = (changeAt) =>
    Array.from({ length: 500 }, (_, index) =>
      index === changeAt ? 'CHANGED' : `line ${index}`
    ).join('\n');

  /**
   * Five thousand identical lines are five thousand rows to lay out and nothing to
   * read. Folded by itself where it matters, and always the reader's to unfold — a
   * comparison that hid two thirds of a file without saying so would be one nobody
   * could trust.
   */
  it('shows only the differences, and says how much it folded away', async () => {
    const wrapper = await open({ 'a.txt': long(-1), 'b.txt': long(250) });

    expect(wrapper.get('[data-test="compare-fold"]').attributes('aria-pressed')).toBe('true');
    expect(rows(wrapper).length).toBeLessThan(20);
    expect(wrapper.findAll('[data-test="compare-gap"]').length).toBeGreaterThan(0);
    expect(wrapper.findAll('[data-test="compare-gap"]')[0].text()).toContain('"count":247');
  });

  it('unfolds when the reader says so', async () => {
    const wrapper = await open({ 'a.txt': long(-1), 'b.txt': long(250) });

    await wrapper.get('[data-test="compare-fold"]').trigger('click');

    expect(rows(wrapper)).toHaveLength(500);
    expect(wrapper.findAll('[data-test="compare-gap"]')).toHaveLength(0);
  });

  it('is not folded when it is short', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'one\nTWO' });

    expect(wrapper.get('[data-test="compare-fold"]').attributes('aria-pressed')).toBe('false');
  });

  /**
   * A checkbox that can do nothing looks like a checkbox that does nothing. On a short
   * file with changes all through it there is no line more than three from a change,
   * so folding would hide none of it — and that is what the button says.
   */
  it('cannot be pressed when folding would hide nothing', async () => {
    const wrapper = await open({ 'a.txt': 'one\ntwo', 'b.txt': 'ONE\nTWO' });

    const fold = wrapper.get('[data-test="compare-fold"]');
    expect(fold.attributes('disabled')).toBeDefined();
    expect(fold.attributes('title')).toContain('compare.nothingToFold');
  });
});

describe('a comparison of three files', () => {
  const three = () =>
    open(
      {
        'mine.txt': 'a\nMINE\nc',
        'base.txt': 'a\nb\nc',
        'theirs.txt': 'a\nTHEIRS\nc',
      },
      ['mine.txt', 'base.txt', 'theirs.txt']
    );

  it('draws three columns, aligned on the middle one', async () => {
    const wrapper = await three();

    expect(wrapper.get('[data-test="compare-names"]').text()).toBe(
      'mine.txt ↔ base.txt ↔ theirs.txt'
    );
    expect(rows(wrapper)).toHaveLength(3);
  });

  /**
   * Between neighbours only: left and right are not next to each other, and a copy
   * between them would skip the very version the middle is there to be compared
   * against.
   */
  it('takes a difference between neighbours, in both directions', async () => {
    const wrapper = await three();

    expect(wrapper.find('[data-test="compare-copy-forward-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="compare-copy-forward-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="compare-copy-forward-2"]').exists()).toBe(false);
  });

  it('takes the middle’s version over one side’s', async () => {
    const wrapper = await three();
    await wrapper.get('[data-test="compare-next"]').trigger('click');

    await wrapper.get('[data-test="compare-copy-back-0"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="compare-save-0"]').trigger('click');
    await flushPromises();

    expect(api.saveFileContent).toHaveBeenCalledWith('mine.txt', 'a\nb\nc');
  });
});

describe('a comparison that cannot be made', () => {
  it('says so for an address naming one file', async () => {
    const wrapper = await open({ 'a.txt': 'one' }, ['a.txt']);

    expect(wrapper.get('[data-test="compare-failed"]').text()).toContain('compare.needTwo');
  });

  it('says so when a file cannot be read', async () => {
    api.fetchFileContent.mockRejectedValue(new Error('gone'));
    route.query = { paths: ['a.txt', 'b.txt'] };
    route.fullPath = '/compare?paths=a.txt&paths=b.txt';
    const wrapper = mount(CompareView, { global: { mocks: { $t: (key) => key } } });
    await flushPromises();

    expect(wrapper.get('[data-test="compare-failed"]').text()).toContain('gone');
  });
});
