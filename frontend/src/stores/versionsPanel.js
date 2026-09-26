import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { normalizePath } from '@/api';

/**
 * Which file the Versions panel shows.
 *
 * Opened from the file browser with the item that was clicked, or from an
 * editor with just the path of the document it has open. `restored` counts the
 * restores made from the panel, so an editor showing the same file knows to
 * reload what it shows.
 */
export const useVersionsPanelStore = defineStore('versionsPanel', () => {
  const isOpen = ref(false);
  const item = ref(null);
  const restored = ref(0);

  const open = (target) => {
    item.value = target || null;
    isOpen.value = Boolean(target);
  };

  /** Open on a file known only by its path, as an editor knows it. */
  const openPath = (filePath) => {
    const normalized = normalizePath(filePath || '');
    if (!normalized) return;
    const segments = normalized.split('/');
    const name = segments.pop();
    open({ name, path: segments.join('/'), kind: 'file' });
  };

  const close = () => {
    isOpen.value = false;
  };

  const markRestored = () => {
    restored.value += 1;
  };

  const relativePath = computed(() => {
    const it = item.value;
    if (!it || !it.name) return '';
    const parent = normalizePath(it.path || '');
    return normalizePath(parent ? `${parent}/${it.name}` : it.name);
  });

  return { isOpen, item, restored, open, openPath, close, markRestored, relativePath };
});
