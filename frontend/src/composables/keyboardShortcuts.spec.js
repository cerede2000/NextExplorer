import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

/**
 * The keyboard.
 *
 * A hundred and eighteen lines at 0%, and the one that matters is the guard
 * rather than any shortcut: Ctrl+X while somebody is typing a new filename into
 * the rename box must cut the text, not the files. Every shortcut checks it, so
 * every shortcut can lose it.
 *
 * The rest is the same guards as the context menu, reached by a different
 * route — pressing Delete on a read-only share has to be as inert as clicking
 * a greyed-out menu item, and nothing was checking that the two agree.
 */

const combos = {};
const registered = [];

vi.mock('@vueuse/core', () => ({
  useMagicKeys: () =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop !== 'string') return undefined;
          combos[prop] = combos[prop] || ref(false);
          return combos[prop];
        },
      }
    ),
  whenever: (source, callback) => registered.push({ source, callback }),
}));

let actions;
let settings;
let spotlight;
const requestDelete = vi.fn();

vi.mock('@/composables/fileActions', () => ({ useFileActions: () => actions }));
vi.mock('@/composables/useDeleteConfirm', () => ({
  useDeleteConfirm: () => ({ requestDelete }),
}));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => settings }));
vi.mock('@/stores/spotlight', () => ({ useSpotlightStore: () => spotlight }));

import { useKeyboardShortcuts } from './keyboardShortcuts';

let editable = false;

const makeActions = (overrides = {}) => ({
  canCut: ref(true),
  canCopy: ref(true),
  canPaste: ref(true),
  canRename: ref(true),
  runCut: vi.fn(),
  runCopy: vi.fn(),
  runPasteIntoCurrent: vi.fn().mockResolvedValue(),
  runRename: vi.fn(),
  isEditableElement: () => editable,
  ...overrides,
});

/** Press a combination: set the ref, then fire whichever watcher now reads true. */
const press = async (...comboNames) => {
  comboNames.forEach((name) => {
    combos[name] = combos[name] || ref(false);
    combos[name].value = true;
  });
  for (const { source, callback } of registered) {
    if (source.value) await callback();
  }
  comboNames.forEach((name) => (combos[name].value = false));
};

beforeEach(() => {
  Object.keys(combos).forEach((k) => delete combos[k]);
  registered.length = 0;
  requestDelete.mockReset();
  editable = false;
  actions = makeActions();
  settings = {
    gridView: vi.fn(),
    listView: vi.fn(),
    tabView: vi.fn(),
    photosView: vi.fn(),
  };
  spotlight = { isOpen: false, open: vi.fn(), close: vi.fn() };
});

describe('the clipboard shortcuts', () => {
  it.each([
    ['Ctrl+X', 'runCut'],
    ['Ctrl+C', 'runCopy'],
    ['Ctrl+V', 'runPasteIntoCurrent'],
  ])('%s runs %s', async (combo, method) => {
    useKeyboardShortcuts();

    await press(combo);

    expect(actions[method]).toHaveBeenCalled();
  });

  it.each([
    ['Meta+X', 'runCut'],
    ['Meta+C', 'runCopy'],
    ['Meta+V', 'runPasteIntoCurrent'],
  ])('%s does too, for a Mac', async (combo, method) => {
    useKeyboardShortcuts();

    await press(combo);

    expect(actions[method]).toHaveBeenCalled();
  });

  it('Delete asks for confirmation rather than deleting', async () => {
    useKeyboardShortcuts();

    await press('delete');

    expect(requestDelete).toHaveBeenCalled();
  });

  it.each([
    ['cut', 'canCut', 'Ctrl+X', 'runCut'],
    ['copy', 'canCopy', 'Ctrl+C', 'runCopy'],
    ['paste', 'canPaste', 'Ctrl+V', 'runPasteIntoCurrent'],
  ])('does not %s when the guard says no', async (_label, guard, combo, method) => {
    actions = makeActions({ [guard]: ref(false) });
    useKeyboardShortcuts();

    await press(combo);

    expect(actions[method]).not.toHaveBeenCalled();
  });

  /** A rejected paste is reported, not thrown into a keyboard handler. */
  it('swallows a paste that fails rather than leaving it unhandled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    actions = makeActions({
      runPasteIntoCurrent: vi.fn().mockRejectedValue(new Error('destination gone')),
    });
    useKeyboardShortcuts();

    await expect(press('Ctrl+V')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('while somebody is typing', () => {
  /**
   * The whole reason the guard exists. Ctrl+X in a rename box is a text cut;
   * routing it to the file cut takes the selection away mid-rename.
   */
  it.each([
    ['Ctrl+X', 'runCut'],
    ['Ctrl+C', 'runCopy'],
    ['Ctrl+V', 'runPasteIntoCurrent'],
    ['f2', 'runRename'],
  ])('%s does nothing', async (combo, method) => {
    useKeyboardShortcuts();
    editable = true;

    await press(combo);

    expect(actions[method]).not.toHaveBeenCalled();
  });

  it('Delete does nothing either', async () => {
    useKeyboardShortcuts();
    editable = true;

    await press('delete');

    expect(requestDelete).not.toHaveBeenCalled();
  });

  it('the view shortcuts do nothing', async () => {
    useKeyboardShortcuts();
    editable = true;

    await press('Alt+1');

    expect(settings.gridView).not.toHaveBeenCalled();
  });

  it('but a caller that asked to ignore the guard still gets them', async () => {
    useKeyboardShortcuts({ ignoreWhenEditable: false });
    editable = true;

    await press('Ctrl+C');

    expect(actions.runCopy).toHaveBeenCalled();
  });
});

describe('search', () => {
  it('Ctrl+K opens it', async () => {
    useKeyboardShortcuts();

    await press('Ctrl+K');

    expect(spotlight.open).toHaveBeenCalled();
  });

  it('does not reopen one already open', async () => {
    spotlight.isOpen = true;
    useKeyboardShortcuts();

    await press('Ctrl+K');

    expect(spotlight.open).not.toHaveBeenCalled();
  });

  it('Escape closes it', async () => {
    spotlight.isOpen = true;
    useKeyboardShortcuts();

    await press('escape');

    expect(spotlight.close).toHaveBeenCalled();
  });

  /** Escape belongs to whatever else is open when search is not. */
  it('Escape does nothing when it is already closed', async () => {
    useKeyboardShortcuts();

    await press('escape');

    expect(spotlight.close).not.toHaveBeenCalled();
  });
});

describe('switching view', () => {
  it.each([
    ['Alt+1', 'gridView'],
    ['Alt+2', 'listView'],
    ['Alt+3', 'tabView'],
    ['Alt+4', 'photosView'],
  ])('%s switches to %s', async (combo, method) => {
    useKeyboardShortcuts();

    await press(combo);

    expect(settings[method]).toHaveBeenCalled();
  });

  /** Some layouts report the digit row as `Digit1` rather than `1`. */
  it('accepts the Digit form of the key as well', async () => {
    useKeyboardShortcuts();

    await press('Alt+Digit2');

    expect(settings.listView).toHaveBeenCalled();
  });
});

describe('renaming', () => {
  it('F2 renames', async () => {
    useKeyboardShortcuts();

    await press('f2');

    expect(actions.runRename).toHaveBeenCalled();
  });

  it('does nothing when renaming is not allowed here', async () => {
    actions = makeActions({ canRename: ref(false) });
    useKeyboardShortcuts();

    await press('f2');

    expect(actions.runRename).not.toHaveBeenCalled();
  });
});

describe('the groups a caller can switch off', () => {
  it.each([
    ['clipboard', { clipboard: false }, 'Ctrl+C'],
    ['view', { view: false }, 'Alt+1'],
    ['spotlight', { spotlight: false }, 'Ctrl+K'],
    ['rename', { rename: false }, 'f2'],
  ])('registers nothing for %s when it is off', async (_label, options, combo) => {
    useKeyboardShortcuts(options);

    await press(combo);

    expect(actions.runCopy).not.toHaveBeenCalled();
    expect(actions.runRename).not.toHaveBeenCalled();
    expect(settings.gridView).not.toHaveBeenCalled();
    expect(spotlight.open).not.toHaveBeenCalled();
  });
});
