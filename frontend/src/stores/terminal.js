import { defineStore } from 'pinia';
import { computed, reactive } from 'vue';

/**
 * The terminals, one per tab.
 *
 * It used to be one per *window*: a single drawer, a single folder, a single
 * shell. That is what made opening a terminal feel like leaving the application —
 * there was one of it, and it was in the way of everything else.
 *
 * A terminal belongs to the tab it was opened from. Each tab can have one, all of
 * them can be running at once, and bringing another tab forward neither closes a
 * shell nor shows somebody else's. With tabs turned off there is one tab, so
 * there is one terminal, which is what the application always did.
 *
 * Two ways of showing one, and the reader chooses which: the drawer beside what
 * the tab holds, which is the ordinary one, and the whole of the tab, which is
 * what a terminal opened deliberately into its own tab gets. Both are the same
 * session — see `TerminalHost.vue`, which draws them and is the only thing that
 * knows where each one goes.
 *
 * This store holds no shell and no socket. It says which tabs have a terminal,
 * where each starts, and whether it is on screen; what a terminal *is* belongs to
 * `TerminalSurface.vue`, and is kept alive by the host for as long as this store
 * says the session exists.
 */
export const useTerminalStore = defineStore('terminal', () => {
  /** Keyed by tab id. A tab with no entry has never opened one. */
  const sessions = reactive({});

  const sessionFor = (id) => (id && sessions[id]) || null;
  const isOpenIn = (id) => sessionFor(id)?.open === true;

  /**
   * Open one in this tab, in the folder given.
   *
   * `key` counts the launches rather than naming the session: a shell cannot
   * change its mind about where it started, so asking for another folder builds
   * another terminal instead of moving this one. Asking for the same folder again
   * while it is already open does nothing at all — the reader is looking at it.
   */
  const openIn = (id, cwd = '', { input = '', mode = 'drawer' } = {}) => {
    if (!id) return null;
    const path = typeof cwd === 'string' ? cwd : '';
    const existing = sessions[id];
    if (existing && existing.open && existing.path === path && existing.mode === mode && !input) {
      return existing;
    }

    sessions[id] = {
      open: true,
      mode: mode === 'page' ? 'page' : 'drawer',
      path,
      input: typeof input === 'string' ? input : '',
      key: (existing?.key ?? 0) + 1,
    };
    return sessions[id];
  };

  /**
   * Shut the drawer, which ends the shell in it.
   *
   * Ended rather than hidden: a terminal nobody can see is a process nobody can
   * see, and the reader who shut the drawer meant to be done with it. Coming back
   * to a tab is the other case entirely, and that one keeps everything.
   */
  const closeIn = (id) => {
    if (sessions[id]) delete sessions[id];
  };

  const toggleIn = (id, cwd = '', options = {}) =>
    isOpenIn(id) ? closeIn(id) : openIn(id, cwd, options);

  /** Tabs that are gone take their terminals with them. */
  const keepOnly = (ids) => {
    const live = new Set(ids || []);
    for (const id of Object.keys(sessions)) {
      if (!live.has(id)) delete sessions[id];
    }
  };

  /** Which tabs have one, for whoever draws them. */
  const openIds = computed(() => Object.keys(sessions).filter((id) => sessions[id].open));

  return { sessions, sessionFor, isOpenIn, openIn, closeIn, toggleIn, keepOnly, openIds };
});
