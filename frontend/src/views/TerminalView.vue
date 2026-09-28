<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { CommandLineIcon } from '@heroicons/vue/24/outline';
import { normalizePath } from '@/api';
import { usePageTitle } from '@/composables/usePageTitle';
import TerminalSurface from '@/components/TerminalSurface.vue';

/**
 * A terminal at an address of its own.
 *
 * The drawer can only ever show one, and it belongs to the window rather than to
 * anything in it — so two folders could not each have a shell open in them. Here a
 * terminal is a place like a folder or a document: it has an address, so it has a
 * tab, so there can be as many as there are tabs. Each has its own session and
 * keeps it while its tab is behind another.
 *
 * The folder is the address, and it is the folder the shell starts in — which is
 * exactly what the drawer does when it is opened from a listing.
 */
const route = useRoute();
const { t } = useI18n();

const folder = computed(() => {
  const raw = route.params.path;
  const joined = Array.isArray(raw) ? raw.join('/') : typeof raw === 'string' ? raw : '';
  return normalizePath(joined);
});

const name = computed(() => folder.value.split('/').filter(Boolean).pop() || '');

// Named after the folder it is in, as a tab of a folder is: two shells both
// reading "Terminal" are two tabs nobody can tell apart.
usePageTitle(
  computed(() => (name.value ? `${t('titles.terminal')} — ${name.value}` : t('titles.terminal')))
);
</script>

<template>
  <div class="flex h-full w-full flex-col bg-zinc-900 dark:bg-zinc-950">
    <header
      class="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-sm text-neutral-300"
    >
      <CommandLineIcon class="h-4 w-4 shrink-0" />
      <span class="truncate">{{ folder || t('breadcrumb.volumes') }}</span>
    </header>
    <div class="min-h-0 flex-1 overflow-hidden p-4">
      <!-- Built again when the tab is taken to another folder: a shell cannot
           change its mind about where it started. -->
      <TerminalSurface :key="folder" :path="folder" data-test="terminal-surface" />
    </div>
  </div>
</template>
