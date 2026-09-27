import { ref, computed } from 'vue';
import { itemKey } from './items';

/**
 * What is selected, and the entry the keyboard acts on.
 *
 * Asks nothing of the rest of the store but the entries on screen, which is
 * where a key is looked up.
 *
 * @param {import('vue').Ref<Array>} currentPathItems
 */
export const createSelection = (currentPathItems) => {
  const selectedItems = ref([]);
  const keyboardActionItemKey = ref('');
  const selectionMode = ref(false);

  const hasSelection = computed(() => selectedItems.value.length > 0);
  const selectedItemKeys = computed(() => {
    const keys = new Set();
    for (const item of selectedItems.value) {
      const key = itemKey(item);
      if (key) keys.add(key);
    }
    return keys;
  });

  const clearSelection = () => {
    selectedItems.value = [];
  };

  const setSelectionMode = (enabled, options = {}) => {
    selectionMode.value = Boolean(enabled);

    const clearOnDisable = options?.clearOnDisable ?? true;
    if (!selectionMode.value && clearOnDisable) {
      clearSelection();
    }
  };

  const toggleSelectionMode = (options = {}) => {
    setSelectionMode(!selectionMode.value, options);
  };

  const findItemByKey = (key) => currentPathItems.value.find((item) => itemKey(item) === key);

  const keyboardActionItem = computed(() =>
    keyboardActionItemKey.value ? findItemByKey(keyboardActionItemKey.value) || null : null
  );

  const setKeyboardActionItem = (item) => {
    keyboardActionItemKey.value = itemKey(item);
  };

  const clearKeyboardActionItem = () => {
    keyboardActionItemKey.value = '';
  };

  /** Select the entries on screen with these names, if any are. */
  const selectItemsByName = (names) => {
    const wanted = new Set((names || []).filter(Boolean));
    if (wanted.size === 0) return;
    const matches = currentPathItems.value.filter((it) => it && wanted.has(it.name));
    if (matches.length > 0) {
      selectedItems.value = matches;
    }
  };

  /** Select the one entry `destination::name`, if it is on screen. */
  const selectCreated = (destination, name) => {
    const created = name ? findItemByKey(`${destination}::${name}`) : null;
    if (created) selectedItems.value = [created];
    return created || null;
  };

  return {
    selectedItems,
    selectionMode,
    hasSelection,
    selectedItemKeys,
    clearSelection,
    setSelectionMode,
    toggleSelectionMode,
    findItemByKey,
    keyboardActionItem,
    setKeyboardActionItem,
    clearKeyboardActionItem,
    selectItemsByName,
    selectCreated,
  };
};
