import { ref } from 'vue';
import { normalizePath, renameItem as renameItemApi } from '@/api';
import { itemKey } from './items';

/**
 * Renaming in place: the draft, and applying it.
 *
 * @param {object} options
 * @param {import('vue').Ref<string>} options.currentPath
 * @param {ReturnType<import('./selection').createSelection>} options.selection
 * @param {(path: string) => Promise<unknown>} options.fetchPathItems
 * @param {(items: Array, action: string) => boolean} options.warn
 */
export const createRename = ({ currentPath, selection, fetchPathItems, warn }) => {
  const renameState = ref(null);

  const beginRename = (item, options = {}) => {
    if (!item || !item.name) return;

    const key = itemKey(item);
    const existing = selection.findItemByKey(key);
    const target = existing || { ...item };

    selection.selectedItems.value = [target];
    selection.clearKeyboardActionItem();

    renameState.value = {
      key,
      path: normalizePath(target.path || currentPath.value || ''),
      originalName: target.name,
      draft: target.name,
      kind: target.kind,
      isNew: Boolean(options.isNew),
    };
  };

  const setRenameDraft = (value) => {
    if (!renameState.value) return;
    renameState.value.draft = value;
  };

  const cancelRename = () => {
    renameState.value = null;
  };

  const applyRename = async () => {
    const state = renameState.value;
    if (!state) return;

    const newName = state.draft ?? '';
    if (!newName.trim()) {
      renameState.value = null;
      return;
    }

    if (newName === state.originalName) {
      renameState.value = null;
      return;
    }

    const targetPath = state.path;
    const item = selection.findItemByKey(state.key);
    warn(item ? [item] : [], 'Rename');

    const response = await renameItemApi(targetPath, state.originalName, newName);
    const renamedName = response?.item?.name ?? newName;
    renameState.value = null;
    await fetchPathItems(targetPath);
    selection.selectCreated(targetPath, renamedName);
  };

  const isItemBeingRenamed = (item) => {
    if (!renameState.value) return false;
    return itemKey(item) === renameState.value.key;
  };

  return {
    renameState,
    beginRename,
    setRenameDraft,
    cancelRename,
    applyRename,
    isItemBeingRenamed,
  };
};
