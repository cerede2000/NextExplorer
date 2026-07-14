<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDownIcon, QueueListIcon, XMarkIcon } from '@heroicons/vue/24/outline';
import { useFileStore } from '@/stores/fileStore';
import { useOperationTasksStore } from '@/stores/operationTasks';
import { formatBytes } from '@/utils';

const fileStore = useFileStore();
const operationTasksStore = useOperationTasksStore();
const { t } = useI18n();
const isListOpen = ref(false);

const operation = computed(() => operationTasksStore.activeOperation);
const operations = computed(() => operationTasksStore.operations);
const operationCount = computed(() => operationTasksStore.operationCount);
const uploadOperations = computed(() => operations.value.filter((task) => task.type === 'upload'));

const displayOperation = computed(() => {
  const active = operation.value;
  const uploads = uploadOperations.value;
  if (active?.type !== 'upload' || uploads.length < 2) return active;

  const totalBytes = uploads.reduce((total, task) => total + totalBytesFor(task), 0);
  const copiedBytes = uploads.reduce(
    (total, task) => total + Math.min(copiedBytesFor(task), totalBytesFor(task)),
    0
  );
  const reported = uploads.map(percentFor).filter((percent) => percent !== null);
  const destinations = new Set(uploads.map((task) => task.destination).filter(Boolean));

  return {
    ...active,
    itemCount: uploads.length,
    name: '',
    totalBytes,
    copiedBytes,
    percent:
      totalBytes > 0 || reported.length === 0
        ? null
        : Math.round(reported.reduce((total, percent) => total + percent, 0) / reported.length),
    destination: destinations.size === 1 ? uploads[0].destination : '',
  };
});

watch(operationCount, (count) => {
  if (count < 2) isListOpen.value = false;
});

const totalBytesFor = (value) => Number(value?.totalBytes) || 0;
const copiedBytesFor = (value) =>
  Math.min(Number(value?.copiedBytes) || 0, totalBytesFor(value) || Number.POSITIVE_INFINITY);
const percentFor = (value) => {
  const totalBytes = totalBytesFor(value);
  if (totalBytes > 0) {
    return Math.min(100, Math.round((copiedBytesFor(value) / totalBytes) * 100));
  }

  const streamed = value?.percent;
  return Number.isFinite(streamed) ? Math.min(100, Math.max(0, streamed)) : null;
};
const progressLabelFor = (value) => {
  const totalBytes = totalBytesFor(value);
  const percent = percentFor(value);
  if (totalBytes > 0) {
    return `${formatBytes(copiedBytesFor(value))} / ${formatBytes(totalBytes)} · ${percent}%`;
  }
  return percent !== null ? `${percent}%` : t('clipboard.working');
};
const titleFor = (value) => {
  if (!value) return '';

  if (value.type === 'extract') return t('clipboard.extracting', { name: value.name || '' });
  if (value.type === 'compress') return t('clipboard.compressing', { name: value.name || '' });
  if (value.type === 'upload') {
    const count = Number(value.itemCount) || 1;
    const label = t('upload.uploads', {
      count,
      items: count === 1 ? t('common.item') : t('common.items'),
    });
    return value.name ? `${label}: ${value.name}` : label;
  }

  const count = Number(value.itemCount);
  if (!Number.isInteger(count) || count < 1) {
    return value.type === 'move' ? t('clipboard.movingUnknown') : t('clipboard.copyingUnknown');
  }

  const itemsLabel = count === 1 ? t('common.item') : t('common.items');
  if (value.type === 'delete') return `${t('common.deleting')} ${count} ${itemsLabel}`;

  return value.type === 'move'
    ? t('clipboard.moving', { count, items: itemsLabel })
    : t('clipboard.copying', { count, items: itemsLabel });
};

const percent = computed(() => percentFor(displayOperation.value));
const progressLabel = computed(() => progressLabelFor(displayOperation.value));
const destination = computed(() => displayOperation.value?.destination ?? '');
const isTransfer = computed(() => ['copy', 'move'].includes(operation.value?.type));

const selectOperation = (id) => {
  operationTasksStore.selectOperation(id);
  isListOpen.value = false;
};

const cancelOperation = () => {
  if (operation.value?.id) operationTasksStore.cancelOperation(operation.value.id);
};

const cancelTask = (id) => {
  operationTasksStore.cancelOperation(id);
};
</script>

<template>
  <div
    v-if="operation"
    class="fixed right-4 bottom-4 min-w-[360px] max-w-sm rounded-2xl border border-zinc-200/70 dark:border-white/10 bg-white/85 dark:bg-zinc-700/90 backdrop-blur-md shadow-xl ring-1 ring-black/5 p-5"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-start gap-3">
      <div class="min-w-0 grow">
        <h3 class="text-lg font-semibold tracking-tight">
          {{ titleFor(displayOperation) }}
        </h3>
        <div v-if="destination" class="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
          {{ t('common.to') }}
          <span class="text-indigo-600 dark:text-indigo-300 font-medium">{{ destination }}</span>
        </div>
      </div>

      <button
        v-if="operationCount > 1"
        type="button"
        class="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-600"
        :aria-expanded="isListOpen"
        :title="t('clipboard.activeTasks', { count: operationCount })"
        @click="isListOpen = !isListOpen"
      >
        <QueueListIcon class="h-4 w-4" />
        {{ operationCount }}
        <ChevronDownIcon
          class="h-3.5 w-3.5 transition-transform"
          :class="{ 'rotate-180': isListOpen }"
        />
      </button>
      <button
        v-if="operation.cancellable"
        type="button"
        class="shrink-0 rounded-md p-1.5 text-zinc-600 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-wait disabled:opacity-60 dark:text-zinc-200 dark:hover:bg-rose-950/50 dark:hover:text-rose-300"
        :disabled="operation.cancelling"
        :title="t('common.cancel')"
        :aria-label="t('common.cancel')"
        @click="cancelOperation"
      >
        <XMarkIcon class="h-5 w-5" />
      </button>
    </div>

    <div v-if="isListOpen" class="mt-3 border-y border-zinc-200/70 py-2 dark:border-zinc-600">
      <div
        v-for="task in operations"
        :key="task.id"
        class="flex items-center gap-1 rounded-md"
        :class="{ 'bg-zinc-100 dark:bg-zinc-600': task.id === operation.id }"
      >
        <button
          type="button"
          class="flex min-w-0 grow items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-600"
          @click="selectOperation(task.id)"
        >
          <span class="min-w-0 truncate font-medium">{{ titleFor(task) }}</span>
          <span class="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-300">
            {{ progressLabelFor(task) }}
          </span>
        </button>
        <button
          v-if="task.cancellable"
          type="button"
          class="mr-1 shrink-0 rounded-md p-1 text-zinc-500 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-wait disabled:opacity-60 dark:text-zinc-300 dark:hover:bg-rose-950/50 dark:hover:text-rose-300"
          :disabled="task.cancelling"
          :title="t('common.cancel')"
          :aria-label="t('common.cancel')"
          @click="cancelTask(task.id)"
        >
          <XMarkIcon class="h-4 w-4" />
        </button>
      </div>
    </div>

    <div class="mt-3">
      <div
        class="w-full h-2 rounded-full overflow-hidden border border-zinc-200/70 dark:border-zinc-700/50 bg-zinc-100/80 dark:bg-zinc-800/70"
      >
        <div
          v-if="percent !== null"
          class="h-full rounded-full clipboard-bar clipboard-bar--determinate"
          :style="{ width: `${percent}%` }"
        />
        <div v-else class="h-full rounded-full clipboard-bar clipboard-bar--animated" />
      </div>
    </div>

    <div class="mt-2 text-xs text-zinc-600 dark:text-zinc-300 tabular-nums">
      {{ operation.cancelling ? t('common.loading') : progressLabel }}
    </div>

    <label
      v-if="isTransfer"
      class="mt-3 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer select-none"
    >
      <input
        v-model="fileStore.repositionAfterTransfer"
        type="checkbox"
        class="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
      />
      {{ t('clipboard.reposition') }}
    </label>
  </div>
</template>

<style scoped>
.clipboard-bar {
  width: 42%;
  background: linear-gradient(90deg, #4f46e5, #6366f1, #818cf8);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.25),
    0 0 0 1px rgba(79, 70, 229, 0.18),
    0 10px 24px rgba(79, 70, 229, 0.22);
  will-change: transform;
}

.clipboard-bar--animated {
  animation: clipboardSlide 1.35s ease-in-out infinite;
}

.clipboard-bar--determinate {
  transition: width 0.2s ease;
}

@media (prefers-reduced-motion: reduce) {
  .clipboard-bar--animated {
    animation: none;
  }
}

@keyframes clipboardSlide {
  0% {
    transform: translateX(-120%);
  }
  100% {
    transform: translateX(260%);
  }
}
</style>
