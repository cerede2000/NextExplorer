<script setup>
import { computed, ref } from 'vue';
import { CommandLineIcon, ChevronDownIcon } from '@heroicons/vue/24/outline';
import { useI18n } from 'vue-i18n';
import { useTerminalStore } from '@/stores/terminal';
import { useTabNavigation } from '@/composables/tabNavigation';
import { terminalRoute } from '@/utils/terminalRoute';
import { useAuthStore } from '@/stores/auth';
import { useFileStore } from '@/stores/fileStore';
import { useRoute } from 'vue-router';

const terminalStore = useTerminalStore();
const tabNavigation = useTabNavigation();
const { toggle, isOpen } = terminalStore;
const fileStore = useFileStore();
const route = useRoute();

const auth = useAuthStore();
const isAdmin = computed(
  () => Array.isArray(auth.currentUser?.roles) && auth.currentUser.roles.includes('admin')
);

const { t } = useI18n();

const open = ref(true);
const terminalPath = computed(() => (route.name === 'HomeView' ? '' : fileStore.currentPath || ''));

/**
 * A terminal, where this account keeps its terminals.
 *
 * With tabs on it is a place like any other: it takes a tab of its own, and there
 * can be as many as there are tabs — which the drawer could never do, because the
 * drawer belongs to the window rather than to anything in it. Without tabs the
 * drawer is the only way to show one, and it opens exactly as it always has.
 */
const toggleTerminal = () => {
  if (tabNavigation.tabs.enabled) {
    tabNavigation.open(terminalRoute(terminalPath.value).path, { own: true });
    return;
  }
  toggle(terminalPath.value);
};
</script>

<template>
  <div v-if="isAdmin">
    <h4
      class="group flex items-center justify-between pt-2 text-sm text-neutral-400 dark:text-neutral-500 font-medium"
    >
      {{ t('terminal.menuHeading') }}
      <button
        :aria-label="t('common.toggleSection')"
        @click="open = !open"
        class="hidden group-hover:block active:text-black dark:active:text-white text-neutral-500"
      >
        <ChevronDownIcon
          class="h-4 transition-transform duration-300 ease-in-out"
          :class="{ 'rotate-0': open, '-rotate-90': !open }"
        />
      </button>
    </h4>
    <div class="overflow-hidden">
      <transition
        enter-active-class="transition-all duration-500"
        leave-active-class="transition-all duration-500"
        enter-from-class="-mt-[100%]"
        enter-to-class="mt-0"
        leave-from-class="mt-0"
        leave-to-class="-mt-[100%]"
      >
        <div v-if="open" class="overflow-hidden">
          <button
            @click="toggleTerminal"
            :class="[
              'cursor-pointer flex w-full items-center gap-3 my-3 rounded-lg transition-colors duration-200 text-sm',
              isOpen ? 'dark:text-white' : 'dark:text-neutral-300/90',
            ]"
          >
            <CommandLineIcon class="h-[1.38rem]" /> {{ t('terminal.menuOpen') }}
          </button>
        </div>
      </transition>
    </div>
  </div>
</template>
