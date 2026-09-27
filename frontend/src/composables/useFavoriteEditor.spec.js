import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The little form for renaming a favourite and choosing its icon.
 *
 * Most of it is filling fields, and one part is not: the icon is stored as a
 * single string, `"variant:IconName"`, and this both splits it apart for the
 * form and puts it back together to save. A split that loses the variant turns
 * every solid icon into an outline one the next time somebody touches the
 * label — a silent change to something they did not edit.
 *
 * The name field is prefilled from the path when there is no label yet, because
 * a favourite added from the toolbar has no label until this form gives it one.
 */

let favoritesStore;

vi.mock('@/stores/favorites', () => ({ useFavoritesStore: () => favoritesStore }));
vi.mock('@/utils/favoriteIcons', () => ({
  normalizeIconVariant: (v) => (['solid', 'outline', 'mini'].includes(v) ? v : 'outline'),
}));

/** A singleton, so each test needs the module built again. */
const freshEditor = async () => {
  vi.resetModules();
  favoritesStore = { updateFavorite: vi.fn().mockResolvedValue() };
  const { useFavoriteEditor } = await import('./useFavoriteEditor');
  return useFavoriteEditor();
};

const favorite = (extra = {}) => ({ id: 'f1', path: 'Docs/2026', ...extra });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('opening it', () => {
  it('fills the fields from the favourite', async () => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(favorite({ label: 'Year 2026', icon: 'solid:FolderIcon' }));

    expect(editor.isFavoriteEditorOpen.value).toBe(true);
    expect(editor.editorName.value).toBe('Year 2026');
    expect(editor.editorPath.value).toBe('Docs/2026');
    expect(editor.editorIconVariant.value).toBe('solid');
    expect(editor.editorIcon.value).toBe('FolderIcon');
  });

  /** A favourite added from the toolbar has no label yet; the folder name is it. */
  it('prefills the name from the last path segment when there is no label', async () => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(favorite());

    expect(editor.editorName.value).toBe('2026');
  });

  it('uses the whole path when it has no segments to take', async () => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(favorite({ path: 'Media' }));

    expect(editor.editorName.value).toBe('Media');
  });

  it('defaults to an outline star when the favourite has no icon', async () => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(favorite());

    expect(editor.editorIconVariant.value).toBe('outline');
    expect(editor.editorIcon.value).toBe('StarIcon');
  });

  it('treats a bare icon name as an outline one', async () => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(favorite({ icon: 'HeartIcon' }));

    expect(editor.editorIconVariant.value).toBe('outline');
    expect(editor.editorIcon.value).toBe('HeartIcon');
  });

  it('falls back to outline for a variant nobody recognises', async () => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(favorite({ icon: 'neon:HeartIcon' }));

    expect(editor.editorIconVariant.value).toBe('outline');
    expect(editor.editorIcon.value).toBe('HeartIcon');
  });

  /**
   * `split(':', 2)` truncates rather than keeping the remainder, so anything
   * after a second colon is dropped. Harmless as things stand — icon names are
   * Heroicons identifiers and contain no colons — but pinned, because it is the
   * kind of thing somebody assumes works the other way when adding a format.
   */
  it('keeps the variant and drops anything past a second colon', async () => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(favorite({ icon: 'solid:Icon:With:Colons' }));

    expect(editor.editorIconVariant.value).toBe('solid');
    expect(editor.editorIcon.value).toBe('Icon');
  });

  it('trims space around the icon name', async () => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(favorite({ icon: 'solid: FolderIcon ' }));

    expect(editor.editorIcon.value).toBe('FolderIcon');
  });

  it('keeps a colour, and treats its absence as none', async () => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(favorite({ color: '#ff8800' }));
    expect(editor.editorColor.value).toBe('#ff8800');

    editor.openEditorForFavorite(favorite());
    expect(editor.editorColor.value).toBeNull();
  });

  it.each([
    ['nothing at all', null],
    ['something with no path', { id: 'f1' }],
  ])('refuses to open on %s', async (_label, value) => {
    const editor = await freshEditor();

    editor.openEditorForFavorite(value);

    expect(editor.isFavoriteEditorOpen.value).toBe(false);
  });
});

describe('saving', () => {
  it('puts the variant and the icon name back together', async () => {
    const editor = await freshEditor();
    editor.openEditorForFavorite(favorite({ icon: 'solid:FolderIcon', label: 'Year' }));

    await editor.saveFavoriteEditor();

    expect(favoritesStore.updateFavorite).toHaveBeenCalledWith('f1', {
      label: 'Year',
      icon: 'solid:FolderIcon',
      color: null,
    });
  });

  /**
   * The round trip that matters: opening and saving without touching anything
   * must not change the icon.
   */
  it.each(['solid:FolderIcon', 'outline:StarIcon', 'mini:HeartIcon'])(
    'leaves %s exactly as it was',
    async (icon) => {
      const editor = await freshEditor();
      editor.openEditorForFavorite(favorite({ icon, label: 'x' }));

      await editor.saveFavoriteEditor();

      expect(favoritesStore.updateFavorite.mock.calls[0][1].icon).toBe(icon);
    }
  );

  it('sends the edited name and colour', async () => {
    const editor = await freshEditor();
    editor.openEditorForFavorite(favorite());
    editor.editorName.value = 'Renamed';
    editor.editorColor.value = '#00aa00';

    await editor.saveFavoriteEditor();

    expect(favoritesStore.updateFavorite.mock.calls[0][1]).toMatchObject({
      label: 'Renamed',
      color: '#00aa00',
    });
  });

  it('closes afterwards and forgets what it was editing', async () => {
    const editor = await freshEditor();
    editor.openEditorForFavorite(favorite());

    await editor.saveFavoriteEditor();

    expect(editor.isFavoriteEditorOpen.value).toBe(false);
    expect(editor.currentFavorite.value).toBeNull();
    expect(editor.isSaving.value).toBe(false);
  });

  it('closes rather than hanging when the save fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const editor = await freshEditor();
    favoritesStore.updateFavorite.mockRejectedValue(new Error('server said no'));
    editor.openEditorForFavorite(favorite());

    await editor.saveFavoriteEditor();

    expect(editor.isFavoriteEditorOpen.value).toBe(false);
    expect(editor.isSaving.value).toBe(false);
    error.mockRestore();
  });

  it('sends nothing when nothing was opened', async () => {
    const editor = await freshEditor();

    await editor.saveFavoriteEditor();

    expect(favoritesStore.updateFavorite).not.toHaveBeenCalled();
  });

  /** Something the server never persisted has no id to update. */
  it('sends nothing for a favourite with no id', async () => {
    const editor = await freshEditor();
    editor.openEditorForFavorite({ path: 'Docs' });

    await editor.saveFavoriteEditor();

    expect(favoritesStore.updateFavorite).not.toHaveBeenCalled();
  });

  it('does not send twice on a double click', async () => {
    const editor = await freshEditor();
    let release;
    favoritesStore.updateFavorite.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    );
    editor.openEditorForFavorite(favorite());

    const first = editor.saveFavoriteEditor();
    await editor.saveFavoriteEditor();
    release();
    await first;

    expect(favoritesStore.updateFavorite).toHaveBeenCalledTimes(1);
  });
});

describe('closing without saving', () => {
  it('changes nothing', async () => {
    const editor = await freshEditor();
    editor.openEditorForFavorite(favorite());
    editor.editorName.value = 'Discarded';

    editor.closeFavoriteEditor();

    expect(editor.isFavoriteEditorOpen.value).toBe(false);
    expect(favoritesStore.updateFavorite).not.toHaveBeenCalled();
  });
});

describe('the shared instance', () => {
  it('is the same object for every caller', async () => {
    vi.resetModules();
    favoritesStore = { updateFavorite: vi.fn() };
    const { useFavoriteEditor } = await import('./useFavoriteEditor');

    expect(useFavoriteEditor()).toBe(useFavoriteEditor());
  });
});
