<script setup>
import { computed } from 'vue';
import { formatBytes } from '@/utils';

const props = defineProps({
  usage: { type: Object, default: null },
  compact: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  percentInside: { type: Boolean, default: false },
});

const used = computed(() => Number(props.usage?.used ?? props.usage?.size) || 0);
const total = computed(() => Number(props.usage?.total) || 0);
const free = computed(() => Number(props.usage?.free) || 0);

const percentUsed = computed(() => {
  if (total.value <= 0) return 0;
  return Math.max(
    0,
    Math.min(100, Number(props.usage?.percentUsed) || (used.value / total.value) * 100)
  );
});

const percentLabel = computed(() => `${Math.round(percentUsed.value)}%`);
const title = computed(() => {
  if (total.value <= 0) return '';
  return `${formatBytes(used.value)} / ${formatBytes(total.value)} (${percentLabel.value}) · ${formatBytes(free.value)}`;
});

const barGradient = computed(() => {
  const pct = percentUsed.value;
  if (pct >= 92) {
    return 'linear-gradient(90deg, #ef4444 0%, #e11d48 100%)';
  }
  if (pct >= 84) {
    return 'linear-gradient(90deg, #fb923c 0%, #ef4444 100%)';
  }
  if (pct >= 72) {
    return 'linear-gradient(90deg, #fde047 0%, #f59e0b 55%, #fb923c 100%)';
  }
  return 'linear-gradient(90deg, #22d3ee 0%, #0ea5e9 55%, #3b82f6 100%)';
});

const fillStyle = computed(() => {
  return {
    width: `${percentUsed.value}%`,
    background: barGradient.value,
  };
});

const showUsage = computed(() => total.value > 0);
</script>

<template>
  <div class="min-w-0 select-none" :title="title">
    <div
      v-if="loading && !showUsage"
      class="overflow-hidden rounded-md bg-neutral-200 dark:bg-neutral-700"
      :class="compact ? 'h-1.5' : 'h-2.5'"
    >
      <div class="h-full w-1/2 animate-pulse bg-neutral-300 dark:bg-neutral-600"></div>
    </div>

    <template v-else-if="showUsage">
      <div class="flex items-center gap-2" :class="compact ? 'mb-1' : 'mb-1.5'">
        <div
          class="relative min-w-0 flex-1 overflow-hidden rounded-md bg-neutral-200/90 shadow-inner ring-1 ring-black/5 dark:bg-neutral-700/80 dark:ring-white/10"
          :class="compact ? 'h-1.5' : 'h-3'"
        >
          <div
            class="h-full rounded-md shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
            :class="compact ? '' : 'transition-[width] duration-500 ease-out'"
            :style="fillStyle"
          ></div>
          <span
            v-if="percentInside"
            class="absolute inset-0 flex items-center justify-center text-[0.65rem] font-semibold leading-none text-neutral-900 tabular-nums"
          >
            {{ percentLabel }}
          </span>
        </div>
        <span
          v-if="!percentInside"
          class="shrink-0 tabular-nums font-medium text-neutral-600 dark:text-neutral-300"
          :class="compact ? 'text-[0.65rem]' : 'text-xs'"
        >
          {{ percentLabel }}
        </span>
      </div>

      <div
        v-if="!compact"
        class="flex items-center justify-between gap-3 text-[0.68rem] leading-none text-neutral-500 dark:text-neutral-400"
      >
        <span class="truncate tabular-nums">{{ formatBytes(used) }}</span>
        <span class="truncate tabular-nums">{{ formatBytes(total) }}</span>
      </div>
    </template>
  </div>
</template>
