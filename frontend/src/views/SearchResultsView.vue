<script setup>
import { matchLabelKey } from '@/utils/searchMatch';
import { ref, onMounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { search as searchApi, normalizePath } from '@/api';
import FileIcon from '@/icons/FileIcon.vue';
import { folderRoute } from '@/utils/folderRoute';

const route = useRoute();
const { t } = useI18n();
const router = useRouter();

const items = ref([]);
/** Why the answer is short of everything, or null when it is not. */
const shortfall = ref(null);
/** Whether what was asked for is too short to be worth sending. */
const tooShort = ref(false);
const MIN_TERM_LENGTH = 3;
/** A page is a hundred; the rest is asked for rather than held open. */
const LIMIT_STEPS = [100, 300, 500];
const askedLimit = ref(LIMIT_STEPS[0]);
const canShowMore = computed(
  () => shortfall.value?.kind === 'first' && askedLimit.value < LIMIT_STEPS[LIMIT_STEPS.length - 1]
);
const showMore = () => {
  askedLimit.value = LIMIT_STEPS.find((step) => step > askedLimit.value) ?? askedLimit.value;
  load();
};
let lastAsked = null;
const loading = ref(false);
const errorMsg = ref('');
/**
 * Whether a search has actually finished for what is being asked now.
 *
 * "No matches" is an answer, and it may only be shown once there is one. Before
 * this existed the empty list said it from the first frame — and again whenever
 * an earlier request finished while a newer one was still running, since any
 * completion cleared `loading`. Someone watching read it as a search that had
 * run and found nothing.
 */
const searched = ref(false);

// Only the newest search may write to the view; an older one that comes back
// late has been superseded and its results are not the ones being asked for.
let currentRequest = 0;

const q = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''));
const basePath = computed(() =>
  normalizePath(typeof route.query.path === 'string' ? route.query.path : '')
);

async function load() {
  const term = q.value.trim();
  const request = (currentRequest += 1);

  if (term !== lastAsked) {
    lastAsked = term;
    askedLimit.value = LIMIT_STEPS[0];
  }
  items.value = [];
  shortfall.value = null;
  errorMsg.value = '';
  searched.value = false;

  // The server refuses fewer than three characters; said here rather than sent
  // and bounced back as an error.
  if (term.length < MIN_TERM_LENGTH) {
    tooShort.value = term.length > 0;
    loading.value = false;
    searched.value = term.length === 0 ? false : true;
    return;
  }
  tooShort.value = false;

  loading.value = true;
  try {
    const {
      items: list = [],
      truncated = false,
      complete = true,
      limit,
    } = await searchApi(basePath.value, term, askedLimit.value);
    if (request !== currentRequest) return;
    items.value = Array.isArray(list) ? list : [];
    // Why the list may be shorter than the truth, said rather than left to
    // look like the whole answer.
    shortfall.value = truncated
      ? { kind: 'stopped' }
      : complete
        ? null
        : { kind: 'first', count: Number.isFinite(limit) ? limit : items.value.length };
    searched.value = true;
  } catch (e) {
    if (request !== currentRequest) return;
    errorMsg.value = e?.message || t('errors.searchFailed');
    searched.value = true;
  } finally {
    // Only the search still being awaited may say the waiting is over.
    if (request === currentRequest) loading.value = false;
  }
}

onMounted(load);
watch(() => [q.value, basePath.value], load);

function openResult(it) {
  if (!it) return;
  const kind = it.kind === 'dir' ? 'dir' : 'file';
  // Open the matched folder itself for directories; open parent for files
  const target = kind === 'dir' ? [it.path, it.name].filter(Boolean).join('/') : it.path || '';
  const normalized = normalizePath(target || '');
  // Naming the file is what lets the folder open on it rather than at the
  // top: landing in the right folder and leaving the reader to find the row
  // themselves is most of the way to not having searched at all.
  router.push(
    folderRoute(normalized, kind === 'file' && it.name ? { select: it.name } : undefined)
  );
}

function toIconItem(it) {
  if (!it) return { name: '', path: '', kind: 'unknown' };
  const isDir = it.kind === 'dir';
  let ext = 'unknown';
  if (!isDir) {
    const name = String(it.name || '');
    const idx = name.lastIndexOf('.');
    if (idx > 0 && idx < name.length - 1) {
      ext = name.slice(idx + 1).toLowerCase();
      if (ext.length > 10) ext = 'unknown';
    } else {
      ext = 'unknown';
    }
  }
  return {
    name: it.name,
    path: it.path,
    kind: isDir ? 'directory' : ext,
  };
}
</script>

<template>
  <!--
    A column of the height it was given, so the list below can be a viewport
    over the results rather than the whole of them. The content area this sits
    in clips, and every other view that lists things does the same thing: the
    trash, both share lists and the folder listing all scroll their own list.
    This one did not, and a hundred results showed ten.
  -->
  <div class="flex h-full min-h-0 flex-col gap-3">
    <div class="text-sm text-neutral-600 dark:text-neutral-300">
      <span v-if="q">{{ $t('search.resultsFor', { q }) }}</span>
      <span v-if="basePath">
        {{ $t('common.in') }}
        <span class="font-mono">/{{ basePath }}</span></span
      >
    </div>

    <div v-if="loading" class="text-sm text-neutral-500 dark:text-neutral-400">
      {{ $t('search.searching') }}
    </div>
    <div v-else-if="errorMsg" class="text-sm text-red-600">{{ errorMsg }}</div>
    <div v-else-if="tooShort" data-test="search-too-short" class="p-6 text-sm text-neutral-500">
      {{ $t('search.tooShort', { count: MIN_TERM_LENGTH }) }}
    </div>
    <div
      v-else-if="searched && items.length === 0"
      class="text-sm text-neutral-500 dark:text-neutral-400"
    >
      {{ $t('search.noMatches') }}
    </div>

    <div
      v-else
      class="min-h-0 flex-1 divide-y divide-neutral-200 overflow-y-auto rounded-md dark:divide-neutral-800"
    >
      <div
        v-for="it in items"
        :key="it.path + '/' + it.name"
        class="flex items-center justify-between p-3 bg-white dark:bg-zinc-800/50"
      >
        <div class="flex items-center gap-3 min-w-0">
          <FileIcon :item="toIconItem(it)" class="w-12 h-12 shrink-0" />
          <div class="min-w-0">
            <div class="flex items-baseline gap-2 min-w-0">
              <div class="font-medium truncate">{{ it.name }}</div>
              <span
                v-if="matchLabelKey(it)"
                data-test="match-kind"
                class="shrink-0 rounded-full px-1.5 text-[0.65rem] font-medium leading-4 text-neutral-500 ring-1 ring-neutral-300 dark:text-neutral-400 dark:ring-neutral-600"
              >
                {{ $t(matchLabelKey(it)) }}
              </span>
            </div>
            <div class="text-xs text-neutral-500 font-mono truncate">/{{ it.path }}</div>
            <div
              v-if="it.matchLine"
              class="mt-1 text-xs text-neutral-700 dark:text-neutral-300 font-mono truncate"
            >
              <template v-if="Number.isFinite(it.matchLineNumber)"
                >{{ $t('search.line') }} {{ it.matchLineNumber }} · </template
              >{{ it.matchLine }}
            </div>
          </div>
        </div>
        <div class="shrink-0 ml-4">
          <button
            class="px-3 py-1 text-sm rounded-md bg-neutral-200 hover:bg-neutral-300 dark:bg-zinc-700 dark:hover:bg-zinc-600"
            @click="openResult(it)"
          >
            {{ $t('search.openFolder') }}
          </button>
        </div>
      </div>

      <p
        v-if="shortfall"
        data-test="search-shortfall"
        class="p-3 text-xs text-amber-700 dark:text-amber-400/90 bg-white dark:bg-zinc-800/50"
      >
        {{
          shortfall.kind === 'stopped'
            ? t('search.stoppedEarly')
            : t('search.firstOnly', { count: shortfall.count })
        }}
        <button
          v-if="canShowMore"
          data-test="search-show-more"
          type="button"
          class="ml-2 underline underline-offset-2 hover:no-underline"
          @click="showMore"
        >
          {{ t('search.showMore') }}
        </button>
      </p>
    </div>
  </div>
</template>
