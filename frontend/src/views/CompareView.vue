<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline';
import { fetchFileContent, getVersionText, saveFileContent } from '@/api';
import {
  alignLines,
  alignThree,
  blocksOf,
  inlineSpans,
  readLines,
  writeLines,
} from '@/utils/textDiff';
import { comparedSides } from '@/utils/compareRoute';
import { usePageTitle } from '@/composables/usePageTitle';
import { useTabNavigation } from '@/composables/tabNavigation';
import { useTabsStore } from '@/stores/tabs';
import { useTabLoadingStore } from '@/stores/tabLoading';
import { useNotificationsStore } from '@/stores/notifications';
import { useCompareSessionsStore } from '@/stores/compareSessions';

/**
 * Two or three files, side by side.
 *
 * A comparison is a *place* here, like a folder or a document: it has an address
 * carrying the paths it is about, so it lives in a tab, can be linked to, and is
 * something the reader leaves and comes back to rather than a dialog they have to
 * finish. Nothing about it is modal.
 *
 * What makes it usable rather than merely correct is the three things a reader
 * actually does with a comparison: step through the differences without hunting for
 * them, take one side's version of a difference over the other's, and save. So the
 * differences are counted and numbered, the keyboard walks them (F7 and F8, as
 * WinMerge has for twenty years, and alt with the arrows for anybody without those
 * keys), and each block can be taken across in either direction.
 *
 * The lines are the state and the alignment is derived from them, which is what
 * makes taking a block across a three-line operation rather than a bookkeeping
 * exercise: replace those lines on that side, and every row, every difference, every
 * count and the position in the row of them is recomputed from that.
 */
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const tabsStore = useTabsStore();
const tabLoading = useTabLoadingStore();
const notifications = useNotificationsStore();
const tabNavigation = useTabNavigation();

/**
 * The tab this screen speaks for, re-read whenever the address changes.
 *
 * Taken once would be wrong for the same reason it was wrong in the text editor:
 * crossing between two comparison tabs never unmounts anything, because both
 * addresses match the same route, so a tab captured at setup goes stale the moment
 * the reader crosses from one comparison to another.
 */
const held = useCompareSessionsStore();
const ownTabId = ref(tabsStore.activeId);
/** The address this screen is showing, which is what a kept comparison belongs to. */
const shownAddress = ref('');
const wantedSides = computed(() => comparedSides(route.query));

/**
 * One entry per file: its lines, how it ends them, and whether it has been changed.
 *
 * The lines are the truth. Everything else on this screen — the rows, the blocks,
 * the counts — is worked out from them, so a copy across has nothing to keep in step.
 */
const sides = ref([]);
const loading = ref(true);
const failed = ref('');

/** left, middle, right — the names the alignment answers with. */
const SIDE_KEYS = [
  ['left', 'right'],
  ['left', 'middle', 'right'],
];
const keys = computed(() => SIDE_KEYS[sides.value.length === 3 ? 1 : 0] || []);
const keyAt = (index) => keys.value[index];

const rows = computed(() => {
  const all = sides.value;
  if (all.length === 3) return alignThree(all[0].lines, all[1].lines, all[2].lines);
  if (all.length === 2) return alignLines(all[0].lines, all[1].lines);
  return [];
});

const blocks = computed(() => blocksOf(rows.value));
/** Which difference the reader is on, counting from zero; -1 before they start. */
const at = ref(-1);
const identical = computed(() => !loading.value && !failed.value && blocks.value.length === 0);

/**
 * Only the differences, with a little around them.
 *
 * What a reader wants from a long file, and what keeps this screen quick: five
 * thousand identical lines are five thousand rows to lay out and nothing to read. On
 * by itself for a file long enough for it to matter, and always the reader's to turn
 * off — a comparison that hides two thirds of a file without saying so would be a
 * comparison nobody could trust.
 */
const CONTEXT_LINES = 3;
const LONG_ENOUGH_TO_FOLD = 400;
const onlyDifferences = ref(false);
const wrap = ref(false);

/**
 * Letting go of the tab this screen was speaking for.
 *
 * Called on the way out of the page *and* on the way from one comparison to
 * another's, because crossing between two comparison tabs unmounts nothing: the only
 * sign that a tab has been left is that the address changed.
 */
const handOver = (key, address) => {
  // Gone with its tab: nothing to hold it for.
  if (!key || !tabsStore.tabs.some((entry) => entry.id === key)) return;
  // Still the tab in front, so the address changed underneath it: this comparison is
  // not what the tab is on any more.
  if (tabsStore.activeId === key) {
    held.forget(key);
    return;
  }
  if (!sides.value.length) return;
  held.keep(key, address, {
    at: at.value,
    onlyDifferences: onlyDifferences.value,
    wrap: wrap.value,
    sides: sides.value.map((side) => ({ ...side, lines: [...side.lines] })),
  });
};

onBeforeUnmount(() => handOver(ownTabId.value, shownAddress.value));

const load = async () => {
  const address = route.fullPath;
  const wanted = wantedSides.value;
  if (wanted.length < 2) {
    failed.value = t('compare.needTwo');
    loading.value = false;
    return;
  }

  /**
   * What this tab was in the middle of, put straight back.
   *
   * No spinner, no second read, and — the part that matters most — the lines taken
   * across and not yet saved are still there. They exist nowhere else.
   */
  const kept = held.sessionFor(ownTabId.value, address);
  if (kept?.sides?.length) {
    sides.value = kept.sides.map((side) => ({ ...side, lines: [...side.lines] }));
    at.value = Number.isInteger(kept.at) ? kept.at : -1;
    onlyDifferences.value = kept.onlyDifferences === true;
    wrap.value = kept.wrap === true;
    shownAddress.value = address;
    loading.value = false;
    failed.value = '';
    return;
  }

  loading.value = true;
  failed.value = '';
  const done = tabLoading.begin(ownTabId.value);
  try {
    const read = await Promise.all(
      wanted.map(async ({ path, versionId }) => {
        // An earlier version is read through its own door, and it is read-only: there
        // is nothing to write back to a version, and the point of having it here is to
        // take lines *out* of it.
        const response = versionId
          ? await getVersionText(path, versionId)
          : await fetchFileContent(path);
        const { lines, newline } = readLines(response?.content ?? '');
        const name = path.split('/').filter(Boolean).pop() || path;
        return {
          path,
          versionId,
          name: versionId ? t('compare.versionOf', { name: response?.name || name }) : name,
          lines,
          newline,
          dirty: false,
          saving: false,
          readOnly: Boolean(versionId),
        };
      })
    );
    sides.value = read;
    at.value = -1;
    shownAddress.value = address;
  } catch (error) {
    failed.value = error?.message || t('compare.failed');
    sides.value = [];
  } finally {
    loading.value = false;
    done();
  }
};

/**
 * The address changed under this screen: another comparison, or another tab holding
 * one. Which of the two it was is what `activeId` says, and it is the only moment
 * this page can change hands — so what the tab it was speaking for should keep is
 * settled first, and the new tab is adopted before anything is read.
 */
watch(
  () => route.fullPath,
  () => {
    handOver(ownTabId.value, shownAddress.value);
    ownTabId.value = tabsStore.activeId;
    void load();
  }
);

/**
 * And the first read, once, outside that watcher.
 *
 * Not `immediate`, which is the trap: on a fresh mount the watcher would run its
 * change-of-hands with the tab it is about to adopt, and a change of hands to the tab
 * in front means "the address changed underneath it, forget what it held" — so the
 * comparison the previous instance had just handed over was thrown away a moment
 * before this one asked for it. Every glance at another tab read both files again, and
 * the two of them looked exactly like a feature that did not work.
 */
void load();

usePageTitle(
  computed(() =>
    sides.value.length ? sides.value.map((side) => side.name).join(' ↔ ') : t('compare.title')
  )
);

/**
 * Stepping through the differences.
 *
 * Wrapping round, because a comparison is read in circles — somebody on the last
 * difference pressing "next" means "start again", not "do nothing", and a button that
 * does nothing is a button they press twice to be sure.
 */
const rowRefs = ref({});
const setRowRef = (index, element) => {
  if (element) rowRefs.value[index] = element;
  else delete rowRefs.value[index];
};

const goToBlock = async (index) => {
  const total = blocks.value.length;
  if (total === 0) return;
  const wanted = ((index % total) + total) % total;
  at.value = wanted;
  await nextTick();
  rowRefs.value[blocks.value[wanted].from]?.scrollIntoView?.({
    block: 'center',
    behavior: 'smooth',
  });
};

const next = () => goToBlock(at.value + 1);
const previous = () => goToBlock(at.value <= 0 ? blocks.value.length - 1 : at.value - 1);

/**
 * One side's version of a difference, taken over the other's.
 *
 * The rows say which lines each side contributes to the block, so the whole
 * operation is: take those lines from one side, put them where the other side's were.
 * A block the target side has nothing in — a run only the source has — goes in after
 * the last line the target does have above it, which is the only place it can mean
 * anything.
 */
const copyBlock = (fromIndex, toIndex, blockIndex = at.value) => {
  const block = blocks.value[blockIndex];
  const source = sides.value[fromIndex];
  const target = sides.value[toIndex];
  if (!block || !source || !target) return;
  // Never into an earlier version: there is nothing to write it back to, and offering
  // it would be offering to change something that has already happened.
  if (target.readOnly) return;

  const fromKey = keyAt(fromIndex);
  const toKey = keyAt(toIndex);
  const within = rows.value.slice(block.from, block.to + 1);

  const taken = within
    .map((row) => row[fromKey])
    .filter((line) => line !== null && line !== undefined)
    .map((line) => source.lines[line]);

  const replacing = within
    .map((row) => row[toKey])
    .filter((line) => line !== null && line !== undefined);

  let start;
  if (replacing.length) {
    start = replacing[0];
  } else {
    // Nothing of the target's in this block: it goes after the last line of the
    // target above it, or at the very top when there is none.
    let above = -1;
    for (let index = block.from - 1; index >= 0; index -= 1) {
      const line = rows.value[index][toKey];
      if (line !== null && line !== undefined) {
        above = line;
        break;
      }
    }
    start = above + 1;
  }

  target.lines = [
    ...target.lines.slice(0, start),
    ...taken,
    ...target.lines.slice(start + replacing.length),
  ];
  target.dirty = true;

  // The block is gone, so the one at this position is the next one along — which is
  // where somebody working through a file wants to be.
  const total = blocksOf(
    sides.value.length === 3
      ? alignThree(sides.value[0].lines, sides.value[1].lines, sides.value[2].lines)
      : alignLines(sides.value[0].lines, sides.value[1].lines)
  ).length;
  at.value = total === 0 ? -1 : Math.min(blockIndex, total - 1);
};

const save = async (index) => {
  const side = sides.value[index];
  if (!side || side.readOnly || !side.dirty || side.saving) return;
  side.saving = true;
  try {
    await saveFileContent(side.path, writeLines(side.lines, side.newline));
    side.dirty = false;
    notifications.addNotification({
      type: 'success',
      heading: t('compare.saved', { name: side.name }),
    });
  } catch (error) {
    notifications.addNotification({
      type: 'error',
      heading: t('compare.saveFailed', { name: side.name }),
      body: error?.message || '',
    });
  } finally {
    side.saving = false;
  }
};

const anythingUnsaved = computed(() => sides.value.some((side) => side.dirty));

/**
 * Leaving with a side taken across and not saved.
 *
 * Said out loud, because there is no submit button to forget to press: lines taken
 * across exist nowhere but this window until they are saved.
 *
 * Not for another tab coming forward, though — that is not leaving. The comparison is
 * handed to the tab and comes back with it, lines and place and all, so asking there
 * would be asking about something that is not going to happen. It asked, the answer
 * was no, and the reader could not leave their own comparison.
 */
onBeforeRouteLeave(() => {
  if (!anythingUnsaved.value) return true;
  if (tabsStore.activeId !== ownTabId.value) return true;
  return window.confirm(t('compare.leaveUnsaved'));
});

watch(rows, (all) => {
  if (all.length > LONG_ENOUGH_TO_FOLD && blocks.value.length > 0) onlyDifferences.value = true;
});

const shown = computed(() => {
  const all = rows.value;
  if (!onlyDifferences.value || blocks.value.length === 0) {
    return all.map((row, index) => ({ row, index }));
  }

  const keep = new Set();
  for (const block of blocks.value) {
    for (let index = block.from - CONTEXT_LINES; index <= block.to + CONTEXT_LINES; index += 1) {
      if (index >= 0 && index < all.length) keep.add(index);
    }
  }

  const list = [];
  let hidden = 0;
  all.forEach((row, index) => {
    if (keep.has(index)) {
      if (hidden > 0) {
        list.push({ gap: hidden, index: `gap-${index}` });
        hidden = 0;
      }
      list.push({ row, index });
      return;
    }
    hidden += 1;
  });
  if (hidden > 0) list.push({ gap: hidden, index: 'gap-end' });

  return list;
});

/** Which block a row belongs to, so the one being read can be marked. */
const blockAt = (index) =>
  blocks.value.findIndex((block) => index >= block.from && index <= block.to);
const isCurrent = (index) => at.value >= 0 && blockAt(index) === at.value;

const cellFor = (row, index) => {
  const line = row[keyAt(index)];
  if (line === null || line === undefined) return null;
  return { number: line + 1, text: sides.value[index].lines[line] ?? '' };
};

/**
 * The part of a changed line that differs, in three pieces.
 *
 * Only where there are two lines to compare and only for the pair the reader is
 * looking at from: on a line of two hundred characters a mark on the whole line is not an
 * answer, and one character in a long path is exactly the case this is for.
 */
const pieces = (row, index) => {
  const cell = cellFor(row, index);
  if (!cell) return null;
  if (row.kind === 'same' || sides.value.length !== 2) return null;
  const other = cellFor(row, index === 0 ? 1 : 0);
  if (!other) return null;
  const spans = inlineSpans(
    index === 0 ? cell.text : other.text,
    index === 0 ? other.text : cell.text
  );
  if (!spans) return null;
  const span = index === 0 ? spans.left : spans.right;
  return [
    cell.text.slice(0, span.from),
    cell.text.slice(span.from, span.to),
    cell.text.slice(span.to),
  ];
};

const rowClass = (row) => {
  if (row.kind === 'same') return '';
  return 'bg-amber-50/70 dark:bg-amber-500/10';
};

const cellClass = (row, index) => {
  const cell = cellFor(row, index);
  if (!cell) return 'bg-neutral-100/80 dark:bg-white/5';
  if (row.kind === 'same') return '';
  if (sides.value.length === 3) {
    const middle = cellFor(row, 1);
    if (index === 1 || !middle) return '';
    return cell.text === middle.text ? '' : 'bg-amber-100/70 dark:bg-amber-400/15';
  }
  if (row.kind === 'removed') return 'bg-rose-100/70 dark:bg-rose-500/15';
  if (row.kind === 'added') return 'bg-emerald-100/70 dark:bg-emerald-500/15';
  return 'bg-amber-100/70 dark:bg-amber-400/15';
};

/**
 * The keys a comparison has always had.
 *
 * F8 and F7 walk the differences, which is what WinMerge has done for twenty years
 * and what anybody arriving here will try first; alt with the arrows does the same
 * for a keyboard without function keys, and on a Mac where F-keys do other things by
 * default. Command or control with S saves the side that has been changed — the only
 * one, when only one has.
 */
const onKey = (event) => {
  if (event.defaultPrevented) return;
  const going =
    event.key === 'F8' || (event.altKey && event.key === 'ArrowDown')
      ? 1
      : event.key === 'F7' || (event.altKey && event.key === 'ArrowUp')
        ? -1
        : 0;
  if (going) {
    event.preventDefault();
    if (going > 0) void next();
    else void previous();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S')) {
    const dirty = sides.value.findIndex((side) => side.dirty);
    if (dirty < 0) return;
    event.preventDefault();
    void save(dirty);
  }
};

window.addEventListener('keydown', onKey);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const close = () => {
  if (tabNavigation.closeOwn()) return;
  void router.push('/browse/');
};
</script>

<template>
  <div class="flex h-full w-full flex-col bg-white dark:bg-default" data-test="compare">
    <header
      class="flex flex-wrap items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800"
    >
      <div class="min-w-0">
        <p class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {{ t('compare.title') }}
        </p>
        <h1 class="truncate text-md text-neutral-900 dark:text-white" data-test="compare-names">
          {{ sides.map((side) => side.name).join(' ↔ ') }}
        </h1>
      </div>

      <div class="flex items-center gap-2 text-sm">
        <span
          v-if="identical"
          class="rounded-md bg-emerald-50 px-2 py-1 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
          data-test="compare-identical"
        >
          {{ t('compare.identical') }}
        </span>
        <span v-else-if="blocks.length" class="text-neutral-600 dark:text-neutral-300">
          <span data-test="compare-count">{{
            t('compare.differences', { count: blocks.length })
          }}</span>
          <span v-if="at >= 0" class="ml-2 text-neutral-500 dark:text-neutral-400">
            {{ t('compare.position', { index: at + 1, count: blocks.length }) }}
          </span>
        </span>
      </div>

      <div class="ml-auto flex flex-wrap items-center gap-1">
        <button
          type="button"
          class="rounded-md p-1.5 text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-white/10"
          :disabled="!blocks.length"
          :title="t('compare.previous')"
          :aria-label="t('compare.previous')"
          data-test="compare-previous"
          @click="previous"
        >
          <ArrowUpIcon class="h-5 w-5" />
        </button>
        <button
          type="button"
          class="rounded-md p-1.5 text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-white/10"
          :disabled="!blocks.length"
          :title="t('compare.next')"
          :aria-label="t('compare.next')"
          data-test="compare-next"
          @click="next"
        >
          <ArrowDownIcon class="h-5 w-5" />
        </button>

        <!-- Taking one side's version over the other's, for the difference being
             read. Between neighbours only: with three files, left and right are not
             next to each other and a copy between them would skip the very version
             the middle is there to be compared against. -->
        <template v-for="(side, index) in sides.slice(0, -1)" :key="`pair-${index}`">
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-white/10"
            :disabled="at < 0 || sides[index + 1].readOnly"
            :title="t('compare.copyForward', { from: side.name, to: sides[index + 1].name })"
            :data-test="`compare-copy-forward-${index}`"
            @click="copyBlock(index, index + 1)"
          >
            <ArrowRightIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-white/10"
            :disabled="at < 0 || side.readOnly"
            :title="t('compare.copyBack', { from: sides[index + 1].name, to: side.name })"
            :data-test="`compare-copy-back-${index}`"
            @click="copyBlock(index + 1, index)"
          >
            <ArrowLeftIcon class="h-4 w-4" />
          </button>
        </template>

        <label class="ml-2 flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
          <input
            v-model="onlyDifferences"
            type="checkbox"
            class="rounded"
            data-test="compare-fold"
          />
          {{ t('compare.onlyDifferences') }}
        </label>
        <label class="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
          <input v-model="wrap" type="checkbox" class="rounded" data-test="compare-wrap" />
          {{ t('compare.wrap') }}
        </label>

        <button
          v-for="(side, index) in sides"
          v-show="!side.readOnly"
          :key="`save-${side.path}-${side.versionId || 'now'}`"
          type="button"
          class="rounded-md px-2 py-1.5 text-sm text-accent transition hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-white/10"
          :disabled="!side.dirty || side.saving"
          :title="t('compare.save', { name: side.name })"
          :data-test="`compare-save-${index}`"
          @click="save(index)"
        >
          {{ t('compare.save', { name: side.name }) }}
        </button>

        <button
          type="button"
          class="rounded-md p-1.5 text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/10"
          :title="t('common.close')"
          :aria-label="t('common.close')"
          data-test="compare-close"
          @click="close"
        >
          <XMarkIcon class="h-5 w-5" />
        </button>
      </div>
    </header>

    <div
      v-if="loading"
      class="flex flex-1 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400"
      data-test="compare-loading"
    >
      {{ t('common.loading') }}
    </div>
    <div
      v-else-if="failed"
      class="p-6 text-sm text-red-600 dark:text-red-400"
      data-test="compare-failed"
    >
      {{ failed }}
    </div>

    <template v-else>
      <!-- One header row of names, so a column is never a mystery on a long file. -->
      <div
        class="grid border-b border-neutral-200 bg-neutral-50 text-xs font-medium text-neutral-600 dark:border-neutral-800 dark:bg-white/5 dark:text-neutral-300"
        :style="{ gridTemplateColumns: `repeat(${sides.length}, minmax(0, 1fr))` }"
      >
        <div
          v-for="side in sides"
          :key="`head-${side.path}`"
          class="truncate border-l border-neutral-200 px-3 py-1 first:border-l-0 dark:border-neutral-800"
          :title="side.path"
        >
          {{ side.name }}
          <span v-if="side.dirty" class="text-amber-600 dark:text-amber-400">•</span>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto font-mono text-xs" data-test="compare-rows">
        <div
          v-for="entry in shown"
          :key="entry.index"
          :ref="(element) => (entry.row ? setRowRef(entry.index, element) : null)"
        >
          <!-- What was folded away, said out loud: a comparison that hid two thirds
               of a file without saying so would be one nobody could trust. -->
          <div
            v-if="entry.gap"
            class="border-y border-dashed border-neutral-200 bg-neutral-50 px-3 py-1 text-center text-[11px] text-neutral-500 dark:border-neutral-800 dark:bg-white/5 dark:text-neutral-400"
            data-test="compare-gap"
          >
            {{ t('compare.folded', { count: entry.gap }) }}
          </div>
          <div
            v-else
            class="grid"
            :class="[
              rowClass(entry.row),
              isCurrent(entry.index) ? 'ring-1 ring-inset ring-accent' : '',
            ]"
            :style="{ gridTemplateColumns: `repeat(${sides.length}, minmax(0, 1fr))` }"
            :data-kind="entry.row.kind"
            :data-current="isCurrent(entry.index) ? 'true' : 'false'"
            data-test="compare-row"
          >
            <div
              v-for="(side, index) in sides"
              :key="`${entry.index}-${index}`"
              class="flex min-w-0 border-l border-neutral-200/70 dark:border-neutral-800 first:border-l-0"
              :class="cellClass(entry.row, index)"
            >
              <span
                class="w-12 shrink-0 select-none border-r border-neutral-200/70 px-1 text-right text-neutral-400 dark:border-neutral-800 dark:text-neutral-500"
              >
                {{ cellFor(entry.row, index)?.number ?? '' }}
              </span>
              <span
                class="min-w-0 flex-1 px-2"
                :class="wrap ? 'whitespace-pre-wrap break-words' : 'overflow-hidden whitespace-pre'"
              >
                <template v-if="pieces(entry.row, index)">
                  <span>{{ pieces(entry.row, index)[0] }}</span
                  ><span
                    class="rounded bg-amber-300/60 dark:bg-amber-400/40"
                    data-test="compare-inline"
                    >{{ pieces(entry.row, index)[1] }}</span
                  ><span>{{ pieces(entry.row, index)[2] }}</span>
                </template>
                <template v-else>{{ cellFor(entry.row, index)?.text ?? '' }}</template>
              </span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
