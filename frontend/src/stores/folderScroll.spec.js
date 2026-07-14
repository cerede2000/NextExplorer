import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { FOLDER_SCROLL_POSITION_LIMIT, useFolderScrollStore } from './folderScroll';

describe('folder scroll positions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('remembers a non-negative position per folder', () => {
    const store = useFolderScrollStore();

    store.remember('volume/parent', 734.8);
    store.remember('volume/child', -50);

    expect(store.get('volume/parent')).toBe(735);
    expect(store.get('volume/child')).toBe(0);
    expect(store.get('volume/missing')).toBe(0);
  });

  it('keeps the most recently used positions within the session limit', () => {
    const store = useFolderScrollStore();

    for (let index = 0; index <= FOLDER_SCROLL_POSITION_LIMIT; index += 1) {
      store.remember(`volume/folder-${index}`, index);
    }

    expect(store.has('volume/folder-0')).toBe(false);
    expect(store.get(`volume/folder-${FOLDER_SCROLL_POSITION_LIMIT}`)).toBe(
      FOLDER_SCROLL_POSITION_LIMIT
    );
  });

  it('restores a remembered position only after an explicit navigation permit', () => {
    const store = useFolderScrollStore();

    store.remember('volume/parent::list', 420);

    expect(store.consumeRestore('volume/parent::list')).toBe(0);

    store.permitRestore('volume/parent');
    expect(store.consumeRestore('volume/parent::list')).toBe(420);
    expect(store.consumeRestore('volume/parent::list')).toBe(0);
  });

  it('preserves an editor return through the generic navigation guard', () => {
    const store = useFolderScrollStore();

    store.remember('volume/parent::list', 420);
    store.permitExplicitRestore('volume/parent');
    store.preventRestore('volume/parent');

    expect(store.consumeRestore('volume/parent::list')).toBe(420);
  });
});
