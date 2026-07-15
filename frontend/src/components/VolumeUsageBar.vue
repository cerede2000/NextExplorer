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

const progressColors = computed(() => {
  const pct = percentUsed.value;
  if (pct >= 92) {
    return ['#ef4444', '#e11d48'];
  }
  if (pct >= 84) {
    return ['#fb923c', '#ef4444'];
  }
  if (pct >= 72) {
    return ['#fde047', '#fb923c'];
  }
  return ['#22d3ee', '#3b82f6'];
});

const barGradient = computed(() => {
  const [start, end] = progressColors.value;
  return `linear-gradient(90deg, ${start} 0%, ${end} 100%)`;
});

const fillStyle = computed(() => {
  return {
    width: `${percentUsed.value}%`,
    background: barGradient.value,
  };
});

const showUsage = computed(() => total.value > 0);
const donutFillStyle = computed(() => ({
  strokeDasharray: `${percentUsed.value} 100`,
  stroke: progressColors.value[1],
}));

// The label is centered in the track. Its background changes once the filled
// portion reaches the center, so choose a color for that actual surface.
const percentLabelClass = computed(() => {
  if (percentUsed.value < 50) {
    return 'text-neutral-900 dark:text-white';
  }
  return percentUsed.value >= 92 ? 'text-white' : 'text-neutral-900';
});
</script>

<template>
  <div class="min-w-0 select-none" :title="title">
    <div
      v-if="compact && loading && !showUsage"
      class="h-[1.38rem] w-[1.38rem] shrink-0 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-700"
    ></div>

    <div
      v-else-if="compact && showUsage"
      class="relative grid h-[1.38rem] w-[1.38rem] shrink-0 place-items-center"
      :aria-label="title"
    >
      <svg class="h-full w-full -rotate-90" viewBox="0 0 36 36" aria-hidden="true">
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke-width="4"
          class="stroke-neutral-200 dark:stroke-neutral-700"
        />
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          pathLength="100"
          stroke-linecap="round"
          stroke-width="4"
          :style="donutFillStyle"
        />
      </svg>
      <span class="absolute text-[0.5rem] font-semibold leading-none tabular-nums text-neutral-700 dark:text-neutral-200">
        {{ percentLabel }}
      </span>
    </div>

    <div
      v-else-if="loading && !showUsage"
      class="h-2.5 overflow-hidden rounded-md bg-neutral-200 dark:bg-neutral-700"
    >
      <div class="h-full w-1/2 animate-pulse bg-neutral-300 dark:bg-neutral-600"></div>
    </div>

    <template v-else-if="showUsage">
      <div class="mb-1.5 flex items-center gap-2">
        <div
          class="relative h-3 min-w-0 flex-1 overflow-hidden rounded-md bg-neutral-200/90 shadow-inner ring-1 ring-black/5 dark:bg-neutral-700/80 dark:ring-white/10"
        >
          <div
            class="h-full rounded-md shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] transition-[width] duration-500 ease-out"
            :style="fillStyle"
          ></div>
          <span
            v-if="percentInside"
            :class="[
              'absolute inset-0 flex items-center justify-center text-[0.65rem] font-semibold leading-none tabular-nums',
              percentLabelClass,
            ]"
          >
            {{ percentLabel }}
          </span>
        </div>
        <span
          v-if="!percentInside"
          class="shrink-0 text-xs font-medium tabular-nums text-neutral-600 dark:text-neutral-300"
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
