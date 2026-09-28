<template>
  <teleport to="body">
    <!-- Backdrop -->
    <transition name="tp-fade">
      <!--
        A panel beside what a tab holds, so it stops where the strip starts.

        It is `fixed` and teleported, which no amount of nesting can tell about
        the strip — hence `--tab-strip-height`, which is 0px when there is no
        strip. Before this the backdrop covered the whole window and swallowed
        every click on a tab: opening the terminal meant being unable to leave it.
      -->
      <div
        v-if="isOpen"
        class="fixed inset-x-0 bottom-0 top-[var(--tab-strip-height)] z-1450 bg-black/30 dark:bg-black/50"
        @click="close"
      />
    </transition>

    <!-- Panel -->
    <div
      class="fixed bottom-0 right-0 top-[var(--tab-strip-height)] z-1500 w-full sm:w-[600px] md:w-[700px] lg:w-[800px] transform transition-transform duration-200 ease-out"
      :class="isOpen ? 'translate-x-0' : 'translate-x-full'"
    >
      <aside
        ref="panelRef"
        class="flex h-full flex-col border-l bg-zinc-900 dark:bg-zinc-950 shadow-2xl dark:border-white/10"
      >
        <header class="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <h2 class="text-lg font-semibold text-white">
            {{ $t('titles.terminal') }}
          </h2>
          <button
            @click="close"
            class="rounded-lg p-1.5 text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
            :aria-label="$t('common.close')"
          >
            <XMarkIcon class="w-5 h-5" />
          </button>
        </header>
        <div class="flex-1 overflow-hidden p-4">
          <!-- Built again whenever the drawer is asked for another folder, which
               is what `launchKey` counts: a shell cannot change its mind about
               where it started. -->
          <TerminalSurface
            :key="launchKey"
            :path="launchPath"
            :initial-input="launchInput"
            :active="isOpen"
          />
        </div>
      </aside>
    </div>
  </teleport>
</template>

<script setup>
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { onClickOutside } from '@vueuse/core';

import { useTerminalStore } from '@/stores/terminal';
import TerminalSurface from '@/components/TerminalSurface.vue';

/**
 * The drawer a terminal used to *be*.
 *
 * What a terminal is — the session, the socket, the folder listing it keeps
 * honest — moved to `TerminalSurface.vue`, because a terminal is a place now and
 * a tab can hold one. What is left here is the drawer: where it sits, what closes
 * it, and which folder it was asked for.
 */
const terminalStore = useTerminalStore();
const { isOpen, launchPath, launchInput, launchKey } = storeToRefs(terminalStore);
const { close } = terminalStore;

const panelRef = ref(null);

onClickOutside(panelRef, () => {
  if (isOpen.value) {
    close();
  }
});
</script>
<style>
.tp-fade-enter-active,
.tp-fade-leave-active {
  transition: opacity 0.2s ease;
}

.tp-fade-enter-from,
.tp-fade-leave-to {
  opacity: 0;
}
</style>
