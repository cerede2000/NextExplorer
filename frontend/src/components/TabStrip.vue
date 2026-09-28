<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onClickOutside } from '@vueuse/core';
import { PlusIcon, XMarkIcon } from '@heroicons/vue/20/solid';
import { TAB_KINDS_BY_ID, tabTitle } from '@/config/tabKinds';
import { useTabNavigation } from '@/composables/tabNavigation';

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
const { tabs, visible, activate, openHome, close, closeOthers } = useTabNavigation();
const { t } = useI18n();

const iconFor = (tab) => TAB_KINDS_BY_ID[tab.kind]?.icon;
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
</script>

<template>
  <div
    v-if="visible"
    class="flex items-end gap-1 overflow-x-auto border-b border-neutral-200 bg-zinc-100 px-2 pt-1 dark:border-neutral-700 dark:bg-neutral-800"
    role="tablist"
    :aria-label="t('tabs.strip')"
    data-test="tab-strip"
  >
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="group relative flex min-w-0 shrink-0 items-center rounded-t-md border border-b-0 text-sm"
      :class="
        tab.id === tabs.activeId
          ? 'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-default'
          : 'border-transparent bg-transparent hover:bg-zinc-200/70 dark:hover:bg-neutral-700/70'
      "
      data-test="tab"
      :data-kind="tab.kind"
      :data-active="tab.id === tabs.activeId ? 'true' : 'false'"
    >
      <button
        type="button"
        role="tab"
        :aria-selected="tab.id === tabs.activeId"
        :title="titleFor(tab)"
        class="flex min-w-0 max-w-56 items-center gap-1.5 px-2 py-1.5"
        @click="activate(tab.id)"
        @auxclick.middle.prevent="close(tab.id)"
        @contextmenu.prevent="openMenu(tab.id)"
      >
        <component :is="iconFor(tab)" v-if="iconFor(tab)" class="h-4 w-4 shrink-0" />
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
      class="mb-1 shrink-0 rounded p-1.5 hover:bg-zinc-200 dark:hover:bg-neutral-700"
      :title="t('tabs.newTab')"
      :aria-label="t('tabs.newTab')"
      data-test="tab-new"
      @click="openHome"
    >
      <PlusIcon class="h-4 w-4" />
    </button>
  </div>
</template>
