<template>
  <!--
    A window rather than the whole screen. What is in an archive is a listing,
    and a listing is read beside what opened it: the preview overlay is for a
    photograph or a document, where filling the screen is the point.
  -->
  <ModalDialog :model-value="true" wide flush @update:model-value="close">
    <template #title>
      <ArchiveIcon class="h-5 w-5 shrink-0" />
      <span class="truncate">{{ item?.name || filePath }}</span>
    </template>

    <div class="flex min-h-0 flex-1 flex-col" data-testid="archive-preview">
      <!--
      Where we are inside the archive, in the shape the explorer's own path bar
      has: the archive itself is the first step, so going back to the top is a
      click rather than a guess at what that level was called.
    -->
      <nav
        class="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-neutral-200 px-4 py-2 text-sm dark:border-neutral-800"
        :aria-label="$t('archive.breadcrumb')"
      >
        <template v-for="(step, index) in trail" :key="step.inside">
          <ChevronRightIcon
            v-if="index > 0"
            class="h-3.5 w-3.5 shrink-0 text-neutral-400"
            aria-hidden="true"
          />
          <button
            type="button"
            class="max-w-[14rem] truncate rounded px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-default disabled:font-medium disabled:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white dark:disabled:text-white"
            :disabled="index === trail.length - 1"
            @click="open(step.inside)"
          >
            {{ step.label }}
          </button>
        </template>
      </nav>

      <p
        v-if="error"
        class="p-6 text-sm text-red-600 dark:text-red-400"
        data-testid="archive-error"
      >
        {{ error }}
      </p>

      <p
        v-else-if="loading"
        class="p-6 text-sm text-neutral-500 dark:text-neutral-400"
        data-testid="archive-loading"
      >
        {{ $t('common.loading') }}
      </p>

      <template v-else-if="reading">
        <ArchiveEntryReader :file-path="filePath" :entry="reading" />
      </template>

      <template v-else>
        <p
          v-if="entries.length === 0"
          class="p-6 text-sm text-neutral-500 dark:text-neutral-400"
          data-testid="archive-empty"
        >
          {{ $t('archive.empty') }}
        </p>

        <div v-else class="flex min-h-0 flex-1 flex-col">
          <!-- The columns the list view uses, in the order it uses them. -->
          <div
            class="archive-row shrink-0 items-center border-b border-neutral-200 px-4 py-1.5 text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
          >
            <input
              type="checkbox"
              class="h-3.5 w-3.5 cursor-pointer accent-blue-600"
              :aria-label="$t('archive.selectAll')"
              :checked="allSelected"
              :indeterminate.prop="selection.size > 0 && !allSelected"
              data-testid="archive-select-all"
              @change="toggleAll"
            />
            <span aria-hidden="true"></span>
            <span>{{ $t('common.name') }}</span>
            <span class="text-right">{{ $t('common.size') }}</span>
            <span class="hidden sm:block">{{ $t('common.modified') }}</span>
            <span aria-hidden="true"></span>
          </div>

          <ul class="min-h-0 flex-1 overflow-y-auto" data-testid="archive-entries">
            <li v-for="entry in entries" :key="entry.path" class="group/item">
              <div
                class="archive-row cursor-default items-center rounded-md px-4 py-1 group-even/item:bg-zinc-100 hover:bg-blue-50 dark:group-even/item:bg-neutral-700/30 dark:hover:bg-blue-900/20"
                :class="{ 'cursor-pointer': opens(entry) }"
                @dblclick="activate(entry)"
              >
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 cursor-pointer accent-blue-600"
                  :aria-label="$t('archive.selectNamed', { name: entry.name })"
                  :checked="selection.has(entry.path)"
                  @change="toggle(entry)"
                  @dblclick.stop
                />

                <FileIcon :item="asItem(entry)" class="w-6 shrink-0" disable-thumbnails />

                <!--
                  A name is a link only where it leads somewhere: a folder to
                  open, or a file the panel can show. Everything else is text,
                  rather than an invitation that ends in an apology.
                -->
                <button
                  v-if="opens(entry)"
                  type="button"
                  :title="entry.name"
                  class="min-w-0 truncate text-left text-sm text-neutral-900 hover:underline dark:text-white"
                  @click="activate(entry)"
                >
                  {{ entry.name }}
                </button>
                <span
                  v-else
                  :title="entry.name"
                  class="min-w-0 truncate text-sm text-neutral-900 dark:text-white"
                >
                  {{ entry.name }}
                </span>

                <span
                  class="text-right text-sm tabular-nums text-neutral-500 dark:text-neutral-400"
                  >{{ entry.isDirectory ? '—' : formatBytes(entry.size ?? 0) }}</span
                >
                <span
                  class="hidden truncate text-sm text-neutral-500 sm:block dark:text-neutral-400"
                  >{{ entry.modified || '—' }}</span
                >

                <span class="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    class="rounded p-1 text-neutral-500 opacity-0 hover:bg-neutral-200 hover:text-neutral-900 group-hover/item:opacity-100 focus:opacity-100 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-white"
                    :title="$t('archive.extract')"
                    :aria-label="$t('archive.extractNamed', { name: entry.name })"
                    :disabled="extracting === entry.path"
                    @click.stop="extract(entry)"
                  >
                    <ArrowUpTrayIcon class="h-4 w-4" aria-hidden="true" />
                  </button>
                  <a
                    v-if="!entry.isDirectory"
                    :href="entryUrl(entry)"
                    class="rounded p-1 text-neutral-500 opacity-0 hover:bg-neutral-200 hover:text-neutral-900 group-hover/item:opacity-100 focus:opacity-100 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-white"
                    :title="$t('archive.download')"
                    :aria-label="$t('archive.downloadNamed', { name: entry.name })"
                    download
                  >
                    <ArrowDownTrayIcon class="h-4 w-4" aria-hidden="true" />
                  </a>
                </span>
              </div>
            </li>
          </ul>
        </div>

        <div
          class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-200 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
        >
          <span data-testid="archive-count">{{ $t('archive.count', total) }}</span>
          <!--
          Said out loud rather than left out silently: an archive can carry
          names that point outside itself, and what cannot be shown as
          somewhere is not shown as somewhere.
        -->
          <span v-if="outside > 0" data-testid="archive-outside">{{
            $t('archive.outside', outside)
          }}</span>
          <span
            v-if="extracted"
            class="text-green-700 dark:text-green-400"
            data-testid="archive-took"
          >
            {{ extracted }}
          </span>

          <!--
            What is selected, and what can be done with it, in the place the
            count already was: an action bar that appears elsewhere moves the
            rows under the pointer as soon as the first box is ticked.
          -->
          <template v-if="selection.size > 0">
            <span class="ml-auto font-medium" data-testid="archive-selected">{{
              $t('archive.selected', selection.size)
            }}</span>
            <button
              type="button"
              class="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
              :disabled="Boolean(extracting)"
              data-testid="archive-extract-selected"
              @click="takeOut([...selection])"
            >
              {{ $t('archive.extract') }}
            </button>
            <button
              type="button"
              class="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
              :disabled="Boolean(extracting)"
              data-testid="archive-extract-elsewhere"
              @click="extractElsewhere"
            >
              {{ $t('archive.extractTo') }}
            </button>
          </template>
        </div>
      </template>
    </div>
  </ModalDialog>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDownTrayIcon, ArrowUpTrayIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';

import { browseArchive, archiveEntryUrl, extractFromArchive } from '@/api';
import { useDestinationPicker } from '@/composables/useDestinationPicker';
import { formatBytes } from '@/utils';
import { isEditableExtension } from '@/config/editor';
import FileIcon from '@/icons/FileIcon.vue';
import ArchiveIcon from '@/icons/files/archive-icon.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import ArchiveEntryReader from './ArchiveEntryReader.vue';
import { entryKind } from './readable';

const props = defineProps({
  item: { type: Object, required: true },
  extension: { type: String, required: true },
  filePath: { type: String, required: true },
  // What the preview host offers a plugin that draws its own window: closing
  // is the host's to do, because it is the host that opened this.
  api: { type: Object, default: () => ({}) },
});

const close = () => props.api?.close?.();

const { t } = useI18n();

const inside = ref('');
const entries = ref([]);
const outside = ref(0);
const total = ref(0);
const loading = ref(true);
const error = ref('');
/** What `extracting` holds while a whole selection is on its way out. */
const SELECTION = '\u0000selection';
const extracting = ref('');
/** The entry being read, or null while the listing is what is on screen. */
const reading = ref(null);
/** The entries ticked at this level, by their path inside the archive. */
const selection = ref(new Set());

const picker = useDestinationPicker();
const extracted = ref('');

/** The archive, then every folder of the position, each one a way back to it. */
const trail = computed(() => {
  const steps = [{ inside: '', label: props.item?.name || props.filePath }];
  let walked = '';
  for (const part of inside.value ? inside.value.split('/') : []) {
    walked = walked ? `${walked}/${part}` : part;
    steps.push({ inside: walked, label: part });
  }
  // A file being read is the last step of the trail, which is what makes the
  // folder it is in a step to go back to rather than a place to guess at.
  if (reading.value) steps.push({ inside: reading.value.path, label: reading.value.name });
  return steps;
});

/** Whether this row's name leads anywhere: into a folder, or into a file. */
const opens = (entry) => entry.isDirectory || Boolean(entryKind(entry.name, isEditableExtension));

const activate = (entry) => {
  if (entry.isDirectory) return open(entry.path);
  if (opens(entry)) reading.value = entry;
};

/** What the shared file icon needs: the same shape a listing gives it. */
const asItem = (entry) => ({
  name: entry.name,
  kind: entry.isDirectory ? 'directory' : entry.name.split('.').pop()?.toLowerCase() || 'unknown',
});

const entryUrl = (entry) => archiveEntryUrl(props.filePath, entry.path);

const toggle = (entry) => {
  if (selection.value.has(entry.path)) selection.value.delete(entry.path);
  else selection.value.add(entry.path);
};

const allSelected = computed(
  () => entries.value.length > 0 && entries.value.every((entry) => selection.value.has(entry.path))
);

const toggleAll = () => {
  if (allSelected.value) {
    selection.value.clear();
    return;
  }
  for (const entry of entries.value) selection.value.add(entry.path);
};

const open = async (position) => {
  reading.value = null;
  // A new level is a new list. Ticks kept from the folder before it would
  // extract things nobody can see any more, which is not what a tick meant.
  selection.value.clear();
  loading.value = true;
  error.value = '';
  extracted.value = '';
  try {
    const level = await browseArchive(props.filePath, position);
    inside.value = level.inside ?? position;
    entries.value = Array.isArray(level.entries) ? level.entries : [];
    outside.value = Number(level.outside) || 0;
    total.value = Number(level.total) || 0;
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

/**
 * Take these entries out onto the volume.
 *
 * Where they land is the folder the archive is in unless a destination is
 * named. What they were called when they landed is what is reported: nothing is
 * ever replaced, so a name already held becomes "name (1)", and saying so is
 * the difference between finding it and looking for it.
 */
const takeOut = async (paths, destination = '') => {
  if (paths.length === 0) return;
  extracting.value = paths.length === 1 ? paths[0] : SELECTION;
  error.value = '';
  extracted.value = '';
  try {
    const result = await extractFromArchive(props.filePath, paths, { destination });
    const placed = result?.items?.length ? result.items : [result?.item].filter(Boolean);
    extracted.value = placed.length
      ? t('archive.extracted', { name: placed.map((item) => item.name).join(', ') })
      : t('archive.extractedNothing');
    // Done is done: boxes left ticked are an invitation to extract the same
    // thing twice, and the second time makes "name (1)".
    selection.value.clear();
  } catch (failure) {
    error.value = failure?.message || t('archive.extractFailed');
  } finally {
    extracting.value = '';
  }
};

const extract = (entry) => takeOut([entry.path]);

/**
 * Somewhere other than the folder the archive is in.
 *
 * The dialog the rest of the application uses for "move to", so the folders
 * offered first are the ones this person actually files things in. Closing it
 * without choosing means do nothing — not the root, and not the default.
 */
const extractElsewhere = async () => {
  const destination = await picker.pick({
    mode: 'extract',
    items: entries.value.filter((entry) => selection.value.has(entry.path)),
    from: props.item?.path || '',
  });
  if (!destination) return;
  await takeOut([...selection.value], destination);
};

onMounted(() => open(''));
watch(
  () => props.filePath,
  () => open('')
);
</script>

<style scoped>
/**
 * Tick, icon, name, size, date, actions — the explorer's own order.
 *
 * The date goes on a phone: five columns across 375 pixels means scrolling
 * sideways to read a size, which is worse than not showing a date nobody asked
 * for. Written here rather than as utility classes because the template is an
 * arbitrary value with a comma in it, and what the build made of that was one
 * column per cell.
 */
.archive-row {
  display: grid;
  gap: 0.5rem;
  grid-template-columns: 1rem 1.5rem minmax(6rem, 1fr) 5.5rem 4rem;
}

@media (min-width: 640px) {
  .archive-row {
    grid-template-columns: 1rem 1.5rem minmax(12rem, 1fr) 6rem 11rem 4.5rem;
  }
}
</style>
