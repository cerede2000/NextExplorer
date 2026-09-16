<template>
  <div class="flex h-full flex-col" data-testid="archive-preview">
    <!--
      Where we are inside the archive. The archive itself is the first step, so
      going back to it is one click rather than a guess at what the first level
      was called.
    -->
    <nav
      class="flex flex-wrap items-center gap-1 border-b border-neutral-200 px-4 py-2 text-sm dark:border-neutral-800"
      :aria-label="$t('archive.breadcrumb')"
    >
      <button
        v-for="(step, index) in trail"
        :key="step.inside"
        type="button"
        class="max-w-[16rem] truncate rounded px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-default disabled:font-medium disabled:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white dark:disabled:text-white"
        :disabled="index === trail.length - 1"
        @click="open(step.inside)"
      >
        {{ step.label }}
      </button>
    </nav>

    <p v-if="error" class="p-6 text-sm text-red-600 dark:text-red-400" data-testid="archive-error">
      {{ error }}
    </p>

    <p
      v-else-if="loading"
      class="p-6 text-sm text-neutral-500 dark:text-neutral-400"
      data-testid="archive-loading"
    >
      {{ $t('common.loading') }}
    </p>

    <template v-else>
      <p
        v-if="entries.length === 0"
        class="p-6 text-sm text-neutral-500 dark:text-neutral-400"
        data-testid="archive-empty"
      >
        {{ $t('archive.empty') }}
      </p>

      <ul v-else class="flex-1 overflow-y-auto" data-testid="archive-entries">
        <li
          v-for="entry in entries"
          :key="entry.path"
          class="flex items-center gap-3 border-b border-neutral-100 px-4 py-2 text-sm last:border-b-0 dark:border-neutral-800"
        >
          <component
            :is="entry.isDirectory ? FolderIcon : DocumentIcon"
            class="h-5 w-5 shrink-0 text-neutral-400"
            aria-hidden="true"
          />

          <button
            v-if="entry.isDirectory"
            type="button"
            class="min-w-0 flex-1 truncate text-left text-neutral-900 hover:underline dark:text-white"
            @click="open(entry.path)"
          >
            {{ entry.name }}
          </button>
          <span v-else class="min-w-0 flex-1 truncate text-neutral-900 dark:text-white">
            {{ entry.name }}
          </span>

          <span class="shrink-0 tabular-nums text-neutral-500 dark:text-neutral-400">
            {{ entry.isDirectory ? '' : formatBytes(entry.size ?? 0) }}
          </span>
          <span class="hidden shrink-0 text-neutral-400 sm:inline dark:text-neutral-500">
            {{ entry.modified || '' }}
          </span>

          <a
            v-if="!entry.isDirectory"
            :href="entryUrl(entry)"
            class="shrink-0 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
            :title="$t('archive.download')"
            :aria-label="$t('archive.downloadNamed', { name: entry.name })"
            download
          >
            <ArrowDownTrayIcon class="h-4 w-4" aria-hidden="true" />
          </a>
        </li>
      </ul>

      <!--
        Said out loud rather than left out silently: an archive can carry names
        that point outside itself, and what cannot be shown as somewhere is not
        shown as somewhere.
      -->
      <p
        v-if="outside > 0"
        class="border-t border-neutral-200 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
        data-testid="archive-outside"
      >
        {{ $t('archive.outside', outside) }}
      </p>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderIcon, DocumentIcon, ArrowDownTrayIcon } from '@heroicons/vue/24/outline';

import { browseArchive, archiveEntryUrl } from '@/api';
import { formatBytes } from '@/utils';

const props = defineProps({
  item: { type: Object, required: true },
  extension: { type: String, required: true },
  filePath: { type: String, required: true },
});

const { t } = useI18n();

const inside = ref('');
const entries = ref([]);
const outside = ref(0);
const loading = ref(true);
const error = ref('');

/** The archive, then every folder of the position, each one a way back to it. */
const trail = computed(() => {
  const steps = [{ inside: '', label: props.item?.name || props.filePath }];
  let walked = '';
  for (const part of inside.value ? inside.value.split('/') : []) {
    walked = walked ? `${walked}/${part}` : part;
    steps.push({ inside: walked, label: part });
  }
  return steps;
});

const entryUrl = (entry) => archiveEntryUrl(props.filePath, entry.path);

const open = async (position) => {
  loading.value = true;
  error.value = '';
  try {
    const level = await browseArchive(props.filePath, position);
    inside.value = level.inside ?? position;
    entries.value = Array.isArray(level.entries) ? level.entries : [];
    outside.value = Number(level.outside) || 0;
  } catch (failure) {
    // The server tells the two apart — an archive behind a password is not a
    // damaged one — and says so in its own sentence; anything it has no
    // sentence for is a failure to read the archive at all.
    error.value = failure?.message || t('archive.unreadable');
    entries.value = [];
  } finally {
    loading.value = false;
  }
};

onMounted(() => open(''));
watch(
  () => props.filePath,
  () => open('')
);
</script>
