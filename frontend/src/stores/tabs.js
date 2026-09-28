import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { useAppSettings } from '@/stores/appSettings';
import { TAB_KINDS_BY_ID, tabKindForPath } from '@/config/tabKinds';

/**
 * The tabs, and which of them is in front.
 *
 * A tab is an address: whichever screen the router is showing is the active tab,
 * and the others are addresses being kept. That is the whole model, and it is why
 * a tab can hold a folder, a document open in ONLYOFFICE or the trash without any
 * of them being a special case — the kinds are declared in `config/tabKinds.js`
 * and recognised from the address.
 *
 * This store never navigates. It says what the tabs are and answers where a tab
 * wants to go; pushing that address is the caller's, which keeps it testable
 * without a router and keeps one place deciding what the address bar says.
 *
 * Kept per device rather than per account, and in the same place the other
 * per-device choices are kept: which folders are open on this screen is not a
 * preference that should follow somebody to their phone. Whether tabs exist at
 * all *is* an account preference — `browseInTabs` — because it is a choice about
 * how the application works rather than about this window.
 */

/** A shape the persisted list can be trusted to have, or it is dropped. */
const isTab = (entry) =>
  Boolean(
    entry &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    entry.id &&
    typeof entry.path === 'string' &&
    TAB_KINDS_BY_ID[entry.kind]
  );

export const HOME = '/browse/';

export const useTabsStore = defineStore('tabs', () => {
  /**
   * Read once and written by hand, rather than through `useStorage`.
   *
   * Two reasons, both found rather than guessed. Its write is deferred, and a
   * reload can arrive first: open a tab, press F5, and the tab was never written —
   * the browser suite came back to one tab and so would a person. Asked to flush
   * synchronously it stopped writing the second change at all, which a test of the
   * round trip caught. A list of three small objects does not need a mechanism; it
   * needs a `setItem` where the change is.
   *
   * Every touch is guarded: a browser with storage blocked or full must still
   * browse, it just will not remember its tabs.
   */
  const OPEN_KEY = 'settings:tabs:open';
  const ACTIVE_KEY = 'settings:tabs:active';

  const read = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage blocked, or full. The tabs still work for as long as this window.
    }
  };

  let nextId = 0;
  const makeId = () => {
    nextId += 1;
    return `tab-${Date.now().toString(36)}-${nextId}`;
  };

  const makeTab = (path) => {
    const kind = tabKindForPath(path);
    return kind ? { id: makeId(), kind: kind.id, path } : null;
  };

  /**
   * What was stored, minus what cannot be opened again.
   *
   * A kind that no longer exists goes, a malformed entry goes, and a kind that
   * says it does not come back goes with them: somebody who closed the browser on
   * a settings page was not in the middle of anything there. What is left is at
   * least one tab, because a window with no tabs has nowhere to be.
   */
  const load = () => {
    const remembered = read(OPEN_KEY, []);
    const kept = (Array.isArray(remembered) ? remembered : [])
      .filter(isTab)
      .filter((entry) => TAB_KINDS_BY_ID[entry.kind].restores)
      .map((entry) => ({ id: entry.id, kind: entry.kind, path: entry.path }));
    return kept.length > 0 ? kept : [makeTab(HOME)];
  };

  const tabs = ref(load());
  const rememberedActive = read(ACTIVE_KEY, '');
  const activeId = ref(
    tabs.value.some((tab) => tab.id === rememberedActive) ? rememberedActive : tabs.value[0].id
  );

  /** Whether this account asked for tabs at all. Read late: the settings load. */
  const enabled = computed(() => useAppSettings().userSettings?.browseInTabs === true);

  const activeTab = computed(
    () => tabs.value.find((tab) => tab.id === activeId.value) || tabs.value[0] || null
  );
  const activeIndex = computed(() => tabs.value.findIndex((tab) => tab.id === activeId.value));
  const count = computed(() => tabs.value.length);
  /** The last tab cannot be closed: there would be nowhere to be. */
  const canClose = computed(() => tabs.value.length > 1);

  /**
   * Write the tabs down, called by each thing that changes them.
   *
   * Explicitly, and not from a deep watcher over the list: that was the first
   * version, and it ran once — on the immediate pass — and never again, so a tab
   * opened after the page loaded was never written. Whatever the reason inside
   * Vue's traversal of a multi-source watcher, a list this small is not worth a
   * mechanism nobody can point at. Five callers say when they changed something.
   */
  const persist = () => {
    write(
      OPEN_KEY,
      tabs.value.map(({ id, kind, path }) => ({ id, kind, path }))
    );
    write(ACTIVE_KEY, activeId.value);
  };
  persist();

  const activate = (id) => {
    if (!tabs.value.some((tab) => tab.id === id)) return null;
    activeId.value = id;
    persist();
    return activeTab.value;
  };

  /**
   * Open an address in a tab, and answer with the tab it is in.
   *
   * A second tab on a screen there is only one of — the trash, the settings — is
   * two views of one thing, so the one already open is brought forward instead.
   * A new tab lands immediately after the one it was opened from, which is where
   * every browser puts it and where the reader will look for it.
   *
   * With tabs turned off there is one tab and it goes where it is told, which is
   * what the application did before any of this existed.
   */
  const open = (path, { activate: shouldActivate = true } = {}) => {
    const kind = tabKindForPath(path);
    if (!kind) return null;

    if (!enabled.value) {
      const current = activeTab.value;
      if (current) {
        current.kind = kind.id;
        current.path = path;
        persist();
      }
      return current;
    }

    if (kind.singleton) {
      const existing = tabs.value.find((tab) => tab.kind === kind.id);
      if (existing) {
        existing.path = path;
        persist();
        return shouldActivate ? activate(existing.id) : existing;
      }
    }

    const tab = makeTab(path);
    const at = activeIndex.value;
    tabs.value.splice(at < 0 ? tabs.value.length : at + 1, 0, tab);
    persist();
    return shouldActivate ? activate(tab.id) : tab;
  };

  /**
   * Close a tab, and answer with the one now in front — or null when nothing
   * moved, which is what closing the only tab does.
   *
   * The tab to the right takes over, and the one to the left when there is no
   * right: closing a run of tabs from one place then walks in one direction
   * rather than jumping about.
   */
  const close = (id) => {
    if (!canClose.value) return null;
    const at = tabs.value.findIndex((tab) => tab.id === id);
    if (at < 0) return null;

    const wasActive = tabs.value[at].id === activeId.value;
    tabs.value.splice(at, 1);
    persist();
    if (!wasActive) return null;

    const next = tabs.value[at] || tabs.value[at - 1];
    return activate(next.id);
  };

  /** Every tab but this one, for the strip's own menu. */
  const closeOthers = (id) => {
    if (!tabs.value.some((tab) => tab.id === id)) return null;
    tabs.value = tabs.value.filter((tab) => tab.id === id);
    persist();
    return activate(id);
  };

  /** The one after, or the one before, wrapping — what ctrl+Tab does. */
  const neighbour = (step) => {
    if (tabs.value.length < 2) return null;
    const at = activeIndex.value;
    const to = (at + step + tabs.value.length) % tabs.value.length;
    return tabs.value[to];
  };

  /** The tab at a position, counting from one, as ctrl+1…9 does. */
  const at = (position) => tabs.value[position - 1] || null;

  /**
   * The router landed somewhere: the active tab is now that place.
   *
   * An address that is not a kind — signing in, a share's password — leaves the
   * tabs alone rather than turning the tab in front into something it cannot be.
   */
  const syncActive = (path) => {
    const kind = tabKindForPath(path);
    const current = activeTab.value;
    if (!kind || !current) return null;
    current.kind = kind.id;
    current.path = path;
    persist();
    return current;
  };

  /**
   * With tabs off there is one tab, and it is the one in front.
   *
   * Otherwise the others would still be there, kept and unreachable, and turning
   * the setting back on would bring back tabs from before it was turned off —
   * state the reader cannot see is state the reader cannot trust.
   *
   * Waited for, and this is the part that had to be found in a browser: at the
   * first paint the settings have not arrived, so `browseInTabs` is not false, it
   * is *unknown* — and a watcher that could not tell the difference threw away
   * every tab a reader had, on every page load, a moment before the answer came.
   * So it acts on what the server said, and only once the server has said it.
   */
  watch(
    () => [enabled.value, useAppSettings().loaded],
    ([on, ready]) => {
      if (!ready) return;
      if (!on && tabs.value.length > 1) closeOthers(activeId.value);
    },
    { immediate: true }
  );

  return {
    tabs,
    activeId,
    activeTab,
    activeIndex,
    count,
    canClose,
    enabled,
    open,
    close,
    closeOthers,
    activate,
    neighbour,
    at,
    syncActive,
  };
});
