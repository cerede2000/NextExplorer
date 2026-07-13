<script setup>
import { computed, ref, onBeforeUnmount } from 'vue';
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
});

const { t } = useI18n();
const store = useQuickActionsStore();
// Item mode injects the context menu (rows live inside its provider). Folder mode
// (toolbar, outside the provider) uses a standalone, dialog-free handler set.
const contextMenu = props.folder ? null : useExplorerContextMenu();
const folderActions = props.folder ? useFolderQuickActions() : null;
const favoritesStore = useFavoritesStore();

const open = ref(false);
const triggerRef = ref(null);
const menuRef = ref(null);
const menuStyle = ref({});

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

const iconFor = (id) =>
  id === 'favorite' && isFav(id) ? StarSolid : QUICK_ACTIONS_BY_ID[id].icon;

const isDanger = (id) => Boolean(QUICK_ACTIONS_BY_ID[id]?.danger);

const closeMenu = () => {
  open.value = false;
  window.removeEventListener('pointerdown', onGlobalPointerDown, true);
  window.removeEventListener('keydown', onGlobalKeydown, true);
  window.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('resize', closeMenu, true);
};

function onGlobalPointerDown(event) {
  const menu = menuRef.value;
  const trigger = triggerRef.value;
  if (menu && (menu === event.target || menu.contains(event.target))) return;
  if (trigger && (trigger === event.target || trigger.contains(event.target))) return;
  closeMenu();
}

function onGlobalKeydown(event) {
  if (event.key === 'Escape') closeMenu();
}

const openMenu = () => {
  const el = triggerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const menuWidth = 224;
  const menuHeight = actionIds.value.length * 36 + 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer opening below; flip above when there isn't room (covers a name in a
  // narrow column — the menu floats over everything, never clipped by the cell).
  const placeAbove = vh - rect.bottom < menuHeight + 8 && rect.top > menuHeight + 8;
  let left = Math.min(rect.right - menuWidth, vw - menuWidth - 8);
  if (left < 8) left = 8;

  const style = { position: 'fixed', left: `${left}px`, width: `${menuWidth}px`, zIndex: 1600 };
  if (placeAbove) style.bottom = `${vh - rect.top + 6}px`;
  else style.top = `${rect.bottom + 6}px`;
  menuStyle.value = style;

  open.value = true;
  window.addEventListener('pointerdown', onGlobalPointerDown, true);
  window.addEventListener('keydown', onGlobalKeydown, true);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu, true);
};

const toggleMenu = (event) => {
  event?.stopPropagation?.();
  event?.preventDefault?.();
  if (open.value) closeMenu();
  else openMenu();
};

const runAction = async (id) => {
  closeMenu();
  try {
    if (props.folder) await folderActions?.run(id);
    else await contextMenu?.runQuickAction?.(props.item, id);
  } catch (error) {
    console.error(`Quick action "${id}" failed`, error);
  }
};

onBeforeUnmount(closeMenu);
</script>

<template>
  <button
    v-if="show"
    ref="triggerRef"
    type="button"
    class="shrink-0 grid h-6 w-6 place-items-center rounded transition-opacity hover:bg-black/10 focus-visible:opacity-100 group-hover/item:opacity-100 group-hover/crumb:opacity-100 dark:hover:bg-white/15"
    :class="open ? 'opacity-100' : 'opacity-0'"
    :title="t('quickActions.menu')"
    :aria-label="t('quickActions.menu')"
    :aria-expanded="open"
    @click.stop.prevent="toggleMenu"
    @dblclick.stop.prevent
    @mousedown.stop
    @pointerdown.stop
  >
    <EllipsisHorizontalIcon class="h-4 w-4" />
  </button>

  <teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      :style="menuStyle"
      class="rounded-xl border border-white/10 bg-white/80 p-1.5 text-sm text-zinc-800 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/80 dark:text-zinc-200"
      @click.stop
      @contextmenu.prevent
    >
      <button
        v-for="id in actionIds"
        :key="id"
        type="button"
        class="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition"
        :class="
          isDanger(id)
            ? 'text-red-600 hover:bg-red-500/20 dark:text-red-500'
            : 'hover:bg-zinc-500/20 dark:hover:bg-zinc-400/20'
        "
        @click.stop="runAction(id)"
      >
        <component :is="iconFor(id)" class="h-4 w-4 opacity-80" />
        <span class="flex-1 font-medium">{{ labelFor(id) }}</span>
      </button>
    </div>
  </teleport>
</template>
