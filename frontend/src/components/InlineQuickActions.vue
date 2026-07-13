<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { EllipsisHorizontalIcon } from '@heroicons/vue/24/outline';
import { StarIcon as StarSolid } from '@heroicons/vue/24/solid';
import { QUICK_ACTIONS_BY_ID } from '@/config/quickActions';
import { useQuickActionsStore } from '@/stores/quickActions';
import { useExplorerContextMenu } from '@/composables/contextMenu';
import { useFolderQuickActions } from '@/composables/useFolderQuickActions';
import { useFavoritesStore } from '@/stores/favorites';
import { normalizePath } from '@/api';

const props = defineProps({
  // A file/folder row item, or null when `folder` is set (current-folder mode).
  item: { type: Object, default: null },
  folder: { type: Boolean, default: false },
  // Hover signal from the parent (row / breadcrumb). Nothing is rendered until it
  // is true, so non-hovered rows carry no quick-action DOM at all — this keeps the
  // list light and its re-renders (e.g. on right-click selection) fast.
  active: { type: Boolean, default: false },
});

const { t } = useI18n();
const store = useQuickActionsStore();
// Item mode reuses the right-click machinery (rows live inside its provider).
// Folder mode (toolbar, outside the provider) uses a dialog-free handler set.
const contextMenu = props.folder ? null : useExplorerContextMenu();
const folderActions = props.folder ? useFolderQuickActions() : null;
const favoritesStore = useFavoritesStore();

// Compact mode: the "…" is shown until it is hovered, then the icons expand.
const expanded = ref(false);
const compact = computed(() => store.displayMode === 'compact');

const isFav = (id) => {
  if (id !== 'favorite') return false;
  if (props.folder) return Boolean(folderActions?.isFavorite?.());
  const it = props.item;
  if (!it || it.kind !== 'directory') return false;
  const path = normalizePath(it.path ? `${it.path}/${it.name}` : it.name);
  return favoritesStore.isFavorite(path);
};

const isAvailable = (id) => {
  const meta = QUICK_ACTIONS_BY_ID[id];
  if (!meta) return false;
  if (props.folder) return meta.folder && Boolean(folderActions?.available(id));
  return meta.item && Boolean(contextMenu?.quickActionAvailable?.(props.item, id));
};

const actionIds = computed(() => (store.enabled ? store.enabledActionIds.filter(isAvailable) : []));

const show = computed(() => actionIds.value.length > 0);

const labelFor = (id) => {
  if (id === 'favorite') {
    return isFav(id) ? t('context.removeFromFavorites') : t('context.addToFavorites');
  }
  return t(QUICK_ACTIONS_BY_ID[id].labelKey);
};

const iconFor = (id) => (id === 'favorite' && isFav(id) ? StarSolid : QUICK_ACTIONS_BY_ID[id].icon);

const isDanger = (id) => Boolean(QUICK_ACTIONS_BY_ID[id]?.danger);

const runAction = async (id, event) => {
  event?.stopPropagation?.();
  event?.preventDefault?.();
  try {
    if (props.folder) await folderActions?.run(id);
    else await contextMenu?.runQuickAction?.(props.item, id);
  } catch (error) {
    console.error(`Quick action "${id}" failed`, error);
  }
};
</script>

<template>
  <!-- Rendered only while the row/breadcrumb is hovered (lazy). Name stays to the
       left; icons sit to its right and wrap onto the line below when there is no
       room. In compact mode only a "…" shows, expanding to the icons on hover. -->
  <div
    v-if="active && show"
    class="flex items-center"
    @mouseenter="expanded = true"
    @mouseleave="expanded = false"
  >
    <button
      v-if="compact && !expanded"
      type="button"
      class="grid h-6 w-6 shrink-0 place-items-center rounded transition-colors hover:bg-black/10 dark:hover:bg-white/15"
      :title="t('quickActions.menu')"
      :aria-label="t('quickActions.menu')"
      @click.stop.prevent
      @dblclick.stop.prevent
      @mousedown.stop
      @pointerdown.stop
    >
      <EllipsisHorizontalIcon class="h-4 w-4" />
    </button>

    <div v-else class="flex max-w-full flex-wrap items-center gap-0.5">
      <button
        v-for="id in actionIds"
        :key="id"
        type="button"
        class="grid h-6 w-6 shrink-0 place-items-center rounded transition-colors"
        :class="
          isDanger(id)
            ? 'text-red-600 hover:bg-red-500/20 dark:text-red-500'
            : 'hover:bg-black/10 dark:hover:bg-white/15'
        "
        :title="labelFor(id)"
        :aria-label="labelFor(id)"
        @click="runAction(id, $event)"
        @dblclick.stop.prevent
        @mousedown.stop
        @pointerdown.stop
      >
        <component :is="iconFor(id)" class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>
