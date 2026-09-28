import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
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
 * Kept per device rather than per account: which folders are open on this screen
 * is not a preference that should follow somebody to their phone. Whether tabs
 * exist at all *is* an account preference — `browseInTabs` — but this store does
 * not go and read it. It is told, by `useTabRouteSync`, and that is not a detail:
 * reaching into the settings store from here put pinia and the router into the
 * module graph of every screen that opens a file, and two specs that had mocked
 * neither stopped loading at all. A store that is told what it needs is a store
 * anything can hold.
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

/**
 * How many tabs a row holds before it refuses another, when nobody has said.
 *
 * Ten is what the settings offer as their middle choice, and what an installation
 * that never opens the setting gets.
 */
export const DEFAULT_TAB_LIMIT = 10;

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

  /**
   * `own` says the tab was opened *for* this address rather than taken to it.
   *
   * It is what lets a document's close button close the tab it is in, and only
   * that tab: closing one somebody had been browsing in and happened to open a
   * document in would take a tab away from them. The same distinction a browser
   * draws when it refuses `window.close()` to a tab that has been somewhere else,
   * and for the same reason.
   */
  const makeTab = (path, own = false) => {
    const kind = tabKindForPath(path);
    return kind ? { id: makeId(), kind: kind.id, path, own } : null;
  };

  /**
   * What was stored, as something openable.
   *
   * A kind that no longer exists goes with the malformed entries, because there is
   * nothing to open. A kind that says it should not come back where it was keeps
   * its tab and comes back at the volumes: the reader had that tab, and losing it
   * because of the page it happened to be showing is not something they asked for.
   * What is left is at least one tab, because a window with no tabs has nowhere to
   * be.
   */
  const load = () => {
    const remembered = read(OPEN_KEY, []);
    const kept = (Array.isArray(remembered) ? remembered : [])
      .filter(isTab)
      .map((entry) =>
        TAB_KINDS_BY_ID[entry.kind].restores
          ? { id: entry.id, kind: entry.kind, path: entry.path, own: entry.own === true }
          : { id: entry.id, kind: 'folder', path: HOME, own: false }
      );
    return kept.length > 0 ? kept : [makeTab(HOME)];
  };

  const tabs = ref(load());
  const rememberedActive = read(ACTIVE_KEY, '');
  const activeId = ref(
    tabs.value.some((tab) => tab.id === rememberedActive) ? rememberedActive : tabs.value[0].id
  );

  /** Whether this account asked for tabs at all. Set from the settings, not read. */
  const enabled = ref(false);

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
      tabs.value.map(({ id, kind, path, own }) => ({ id, kind, path, own }))
    );
    write(ACTIVE_KEY, activeId.value);
  };
  persist();

  /**
   * The tab the reader has just brought forward, until a page asks about it.
   *
   * A page cannot tell that on its own. Bringing a tab forward and walking into a
   * folder both arrive as a new address on the same route, and the listing that
   * mounts for either of them looks exactly the same — which is why coming back
   * to a folder tab read the folder again from the server and landed the reader
   * at the top of it, having thrown away what they had selected.
   *
   * A flag, consumed by whoever it is for, rather than a guess made from what the
   * store happens to be holding: a store already on a folder is also what somebody
   * walking back up to it, or landing on a search result in it, looks like.
   */
  const broughtForward = ref('');

  /** Whether this tab is the one just brought forward. Asking clears it. */
  const takeBroughtForward = (id) => {
    if (!id || broughtForward.value !== id) return false;
    broughtForward.value = '';
    return true;
  };

  const activate = (id) => {
    if (!tabs.value.some((tab) => tab.id === id)) return null;
    activeId.value = id;
    broughtForward.value = id;
    persist();
    return activeTab.value;
  };

  /**
   * How many tabs this installation allows, told by whoever knows.
   *
   * A row of tabs that never scrolls has to stop somewhere: past a certain number
   * they are too narrow to read, and a strip that scrolls hides the very tabs
   * somebody opened. The number is an administrator's to choose — see the Tabs
   * settings — and is told to this store rather than read from here, for the same
   * reason `enabled` is.
   */
  const limit = ref(DEFAULT_TAB_LIMIT);

  const setLimit = (value) => {
    const asked = Number(value);
    limit.value = Number.isFinite(asked) ? Math.max(1, Math.round(asked)) : DEFAULT_TAB_LIMIT;
  };

  /** Whether there is room for another. */
  const atLimit = computed(() => enabled.value && tabs.value.length >= limit.value);

  /**
   * Open an address in a tab, and answer with the tab it is in.
   *
   * A second tab on a screen there is only one of — the trash, the settings — is
   * two views of one thing, so the one already open is brought forward instead.
   * A new tab lands at the end of the row, which is where Edge and Chrome put one
   * and where the reader will look for it.
   *
   * Nothing opens once the row is full: answering null leaves the gesture to say
   * so, rather than making a tab too narrow to read or pushing one out of sight.
   *
   * With tabs turned off there is one tab and it goes where it is told, which is
   * what the application did before any of this existed.
   */
  const open = (path, { activate: shouldActivate = true, own = false } = {}) => {
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
        // Brought forward rather than made, so it is not a tab opened for this.
        existing.own = false;
        persist();
        return shouldActivate ? activate(existing.id) : existing;
      }
    }

    if (atLimit.value) return null;

    const tab = makeTab(path, own);
    tabs.value.push(tab);
    persist();
    return shouldActivate ? activate(tab.id) : tab;
  };

  /**
   * Everything closed, and one new tab at the volumes.
   *
   * A window with no tabs has nowhere to be, so "close them all" means "start
   * again" — which is what it means in a browser, and what somebody who has
   * twelve of them open and wants none of them is asking for.
   */
  const closeAll = () => {
    tabs.value = [makeTab(HOME)];
    activeId.value = tabs.value[0].id;
    persist();
    return activeTab.value;
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

  /**
   * Put a tab somewhere else in the row, and answer with it.
   *
   * The order of the tabs is the reader's, not the application's: they open a
   * folder to compare against another and want the two side by side, and until
   * now the only order available was the order things happened to be opened in.
   *
   * A place outside the row is the nearest end of it rather than nothing, because
   * this is also what a finger dragging a tab past the last one means. Which tab
   * is in front does not change: moving something is not choosing it.
   */
  const move = (id, index) => {
    const from = tabs.value.findIndex((tab) => tab.id === id);
    if (from < 0) return null;
    const to = Math.max(0, Math.min(tabs.value.length - 1, index));
    if (to === from) return tabs.value[from];

    const [moved] = tabs.value.splice(from, 1);
    tabs.value.splice(to, 0, moved);
    persist();
    return moved;
  };

  /** One place along, which is what the menu offers and the ends refuse. */
  const nudge = (id, step) => {
    const from = tabs.value.findIndex((tab) => tab.id === id);
    return from < 0 ? null : move(id, from + step);
  };

  /** Whether there is anywhere that way to go: what greys the menu out. */
  const canMove = (id, step) => {
    const from = tabs.value.findIndex((tab) => tab.id === id);
    return from >= 0 && from + step >= 0 && from + step < tabs.value.length;
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
    // Taken somewhere else, so it is no longer a tab that exists for one thing.
    if (current.path !== path) current.own = false;
    current.kind = kind.id;
    current.path = path;
    persist();
    return current;
  };

  /**
   * Told what the account asked for, and told only once that is known.
   *
   * With tabs off there is one tab, and it is the one in front: the others would
   * otherwise be kept and unreachable, and turning the setting back on would bring
   * back tabs from before it was turned off — state the reader cannot see is state
   * the reader cannot trust.
   *
   * Which is why this is a `set` and not a watcher over the settings. At the first
   * paint the settings have not arrived, so `browseInTabs` is not false, it is
   * *unknown* — and the watcher that could not tell the difference threw away every
   * tab a reader had, on every page load, a moment before the answer came. Whoever
   * calls this knows the answer; nobody calls it guessing.
   */
  const setEnabled = (value) => {
    enabled.value = value === true;
    if (!enabled.value && tabs.value.length > 1) closeOthers(activeId.value);
  };

  return {
    tabs,
    activeId,
    activeTab,
    activeIndex,
    count,
    canClose,
    enabled,
    setEnabled,
    limit,
    setLimit,
    atLimit,
    open,
    close,
    closeOthers,
    closeAll,
    activate,
    takeBroughtForward,
    move,
    nudge,
    canMove,
    neighbour,
    at,
    syncActive,
  };
});
