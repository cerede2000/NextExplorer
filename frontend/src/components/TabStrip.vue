<script setup>
import { computed, onUnmounted, ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { onClickOutside, useElementSize } from '@vueuse/core';
import { PlusIcon, XMarkIcon } from '@heroicons/vue/20/solid';
import { TAB_KINDS_BY_ID, tabFolderPath, tabTitle } from '@/config/tabKinds';
import { useFavoritesStore } from '@/stores/favorites';
import { resolveFavoriteIcon } from '@/utils/favoriteIcons';
import { useTabNavigation } from '@/composables/tabNavigation';
import { useAppSettings } from '@/stores/appSettings';

/**
 * The strip of tabs, above everything a tab can hold.
 *
 * Drawn only where there is something to draw: the account asked for tabs, and
 * the address is one a tab can be on. Signing in is not, so the strip is not
 * there offering to leave the question unanswered.
 *
 * A tab is the button; the cross beside it is a second button rather than one
 * inside the other, which is not something a browser will lay out and not
 * something a screen reader can read.
 */
const { tabs, visible, activate, openHome, close, closeOthers, closeAll } = useTabNavigation();
const { t } = useI18n();

/**
 * Whether a double click on a tab closes it, which is an account's answer.
 *
 * Off by default, because a double click is also how somebody with a trackpad
 * ends up clicking twice: offered rather than assumed, like everything else about
 * tabs.
 */
const appSettings = useAppSettings();
const closesOnDoubleClick = computed(
  () => appSettings.userSettings?.closeTabsOnDoubleClick === true
);
const handleDoubleClick = (id) => {
  if (closesOnDoubleClick.value) close(id);
};

/**
 * How tall the strip is, said out loud.
 *
 * Two surfaces cover the whole window from `body` — the preview host and the media
 * viewer — and a document open in a tab is the tab's content, so it has to stop
 * where the strip starts. Teleported and `fixed`, they cannot be told by being
 * nested inside anything, so they are told by a custom property instead. Measured
 * rather than written down: the strip's height is a consequence of its padding and
 * its type, and a number repeated in a stylesheet would be a number to forget.
 */
const stripElement = ref(null);
const { height } = useElementSize(stripElement);
const publishHeight = (value) => {
  document.documentElement.style.setProperty('--tab-strip-height', `${Math.round(value)}px`);
};
watchEffect(() => {
  publishHeight(visible.value ? height.value : 0);
});
onUnmounted(() => {
  publishHeight(0);
});

/**
 * A tab inside a favourite wears that favourite's icon.
 *
 * Somebody who keeps four folders as favourites picked those icons to tell them
 * apart at a glance, and a row of identical folder icons throws that away. It
 * lasts as long as the tab is in that folder — walk out of it and the tab is an
 * ordinary folder again, because the icon was never the tab's, it was the
 * favourite's.
 *
 * The deepest one wins: a favourite inside another favourite is the more precise
 * answer to "where is this tab".
 */
const favorites = useFavoritesStore();
const favouriteFor = (tab) => {
  const folder = tabFolderPath(tab);
  if (!folder) return null;
  let best = null;
  for (const favorite of favorites.favorites || []) {
    const path = String(favorite?.path || '').replace(/^\/+|\/+$/g, '');
    if (!path) continue;
    if (folder !== path && !folder.startsWith(`${path}/`)) continue;
    if (!best || path.length > best.path.length) best = { path, favorite };
  }
  return best?.favorite || null;
};

const iconFor = (tab) => {
  const favorite = favouriteFor(tab);
  if (favorite) return resolveFavoriteIcon(favorite.icon);
  return TAB_KINDS_BY_ID[tab.kind]?.icon;
};

/** And its colour, since an icon and its colour are one choice, not two. */
const iconColourFor = (tab) => favouriteFor(tab)?.color || undefined;
const titleFor = (tab) => tabTitle(tab, t) || t('tabs.newTab');

// The menu belongs to one tab at a time, named by its id rather than held as the
// tab itself: the tab it was opened on can close while the menu is open.
const menuFor = ref('');
const menu = ref(null);
onClickOutside(menu, () => {
  menuFor.value = '';
});

const openMenu = (id) => {
  menuFor.value = menuFor.value === id ? '' : id;
};

const runAndShut = (action, id) => {
  menuFor.value = '';
  action(id);
};

/**
 * Dragging a tab along the row.
 *
 * The order of the tabs is the reader's: two folders being compared belong side
 * by side, whichever order they happened to be opened in. Dragging is how every
 * browser says this, so it is how this says it too — and the same move is in the
 * tab's own menu, for a touch screen, a trackpad somebody cannot drag with, and
 * anyone reaching the strip from the keyboard.
 *
 * `held` is an id rather than a tab: the tab could close while it is being
 * dragged, and a stale object would be dropped somewhere.
 */
const held = ref('');
const over = ref('');

const startDrag = (id, event) => {
  held.value = id;
  // Firefox starts no drag at all without something on the transfer, and `move`
  // is what this is — no copy of a tab exists.
  event.dataTransfer?.setData('text/plain', id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
};

const dragOver = (id, event) => {
  if (!held.value || id === held.value) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  over.value = id;
};

const endDrag = () => {
  held.value = '';
  over.value = '';
};

/** Dropped on a tab: take the place of the one underneath. */
const dropOn = (id) => {
  const moved = held.value;
  endDrag();
  if (!moved || moved === id) return;
  const to = tabs.tabs.findIndex((tab) => tab.id === id);
  if (to >= 0) tabs.move(moved, to);
};

const nudge = (id, step) => {
  menuFor.value = '';
  tabs.nudge(id, step);
};
</script>

<template>
  <div
    v-if="visible"
    ref="stripElement"
    class="flex items-end gap-1 overflow-hidden border-b border-neutral-200 bg-zinc-100 px-2 pt-1 dark:border-neutral-700 dark:bg-neutral-800"
    role="tablist"
    :aria-label="t('tabs.strip')"
    data-test="tab-strip"
  >
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="group relative flex min-w-0 flex-1 basis-0 items-center rounded-t-md border border-b-0 text-sm has-[+*]:max-w-56 max-w-56"
      :class="
        tab.id === tabs.activeId
          ? 'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-default'
          : 'border-transparent bg-transparent hover:bg-zinc-200/70 dark:hover:bg-neutral-700/70'
      "
      data-test="tab"
      :data-kind="tab.kind"
      :data-active="tab.id === tabs.activeId ? 'true' : 'false'"
      :data-over="over === tab.id ? 'true' : 'false'"
      draggable="true"
      @dragstart="startDrag(tab.id, $event)"
      @dragover.prevent="dragOver(tab.id, $event)"
      @dragleave="over === tab.id && (over = '')"
      @drop.prevent="dropOn(tab.id)"
      @dragend="endDrag"
    >
      <!-- Where it would land, drawn on the tab being passed over rather than
           between two tabs: a strip that scrolls sideways has no gaps to draw in. -->
      <div
        v-if="over === tab.id"
        class="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-accent"
        aria-hidden="true"
      ></div>
      <button
        type="button"
        role="tab"
        draggable="true"
        :aria-selected="tab.id === tabs.activeId"
        :title="titleFor(tab)"
        class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5"
        @click="activate(tab.id)"
        @dblclick="handleDoubleClick(tab.id)"
        @auxclick.middle.prevent="close(tab.id)"
        @contextmenu.prevent="openMenu(tab.id)"
      >
        <component
          :is="iconFor(tab)"
          v-if="iconFor(tab)"
          class="h-4 w-4 shrink-0"
          :style="iconColourFor(tab) ? { color: iconColourFor(tab) } : undefined"
        />
        <span class="truncate">{{ titleFor(tab) }}</span>
      </button>
      <button
        v-if="tabs.canClose"
        type="button"
        class="mr-1 rounded p-0.5 opacity-0 transition-opacity hover:bg-black/10 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-white/15"
        :title="t('tabs.closeTab')"
        :aria-label="t('tabs.closeTab')"
        data-test="tab-close"
        @click.stop="close(tab.id)"
      >
        <XMarkIcon class="h-4 w-4" />
      </button>

      <div
        v-if="menuFor === tab.id"
        ref="menu"
        class="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-neutral-200 bg-zinc-100 p-1 shadow-md dark:border-neutral-600 dark:bg-neutral-700"
        data-test="tab-menu"
      >
        <button
          type="button"
          class="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-200 disabled:opacity-50 dark:hover:bg-neutral-600"
          :disabled="!tabs.canMove(tab.id, -1)"
          data-test="tab-move-left"
          @click="nudge(tab.id, -1)"
        >
          {{ t('tabs.moveLeft') }}
        </button>
        <button
          type="button"
          class="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-200 disabled:opacity-50 dark:hover:bg-neutral-600"
          :disabled="!tabs.canMove(tab.id, 1)"
          data-test="tab-move-right"
          @click="nudge(tab.id, 1)"
        >
          {{ t('tabs.moveRight') }}
        </button>
        <button
          type="button"
          class="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-200 disabled:opacity-50 dark:hover:bg-neutral-600"
          :disabled="!tabs.canClose"
          @click="runAndShut(close, tab.id)"
        >
          {{ t('tabs.closeTab') }}
        </button>
        <button
          type="button"
          class="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-200 disabled:opacity-50 dark:hover:bg-neutral-600"
          :disabled="!tabs.canClose"
          @click="runAndShut(closeOthers, tab.id)"
        >
          {{ t('tabs.closeOthers') }}
        </button>
      </div>
    </div>

    <button
      type="button"
      class="mb-1 shrink-0 rounded p-1.5 hover:bg-zinc-200 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-neutral-700"
      :title="tabs.atLimit ? t('tabs.full', { count: tabs.limit }) : t('tabs.newTab')"
      :aria-label="t('tabs.newTab')"
      :disabled="tabs.atLimit"
      data-test="tab-new"
      @click="openHome"
    >
      <PlusIcon class="h-4 w-4" />
    </button>

    <!-- Everything closed and one new tab at the volumes: a window with no tabs
         has nowhere to be, so "close them all" means "start again". -->
    <button
      v-if="tabs.canClose"
      type="button"
      class="mb-1 shrink-0 rounded p-1.5 hover:bg-zinc-200 dark:hover:bg-neutral-700"
      :title="t('tabs.closeAll')"
      :aria-label="t('tabs.closeAll')"
      data-test="tab-close-all"
      @click="closeAll"
    >
      <XMarkIcon class="h-4 w-4" />
    </button>
  </div>
</template>
