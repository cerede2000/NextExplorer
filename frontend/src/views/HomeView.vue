<script setup>
import { onMounted, computed } from 'vue';
import { useFavoritesStore } from '@/stores/favorites';
import { useFeaturesStore } from '@/stores/features';
import { useVolumeUsageStore } from '@/stores/volumeUsage';
import { useNavigation } from '@/composables/navigation';
import * as OutlineIcons from '@heroicons/vue/24/outline';
import * as SolidIcons from '@heroicons/vue/24/solid';
import VolumeUsageBar from '@/components/VolumeUsageBar.vue';
import IconDrive from '@/icons/IconDrive.vue';

const favoritesStore = useFavoritesStore();
const featuresStore = useFeaturesStore();
const volumeUsageStore = useVolumeUsageStore();
const { openItem, openBreadcrumb } = useNavigation();
const showVolumeUsage = computed(() => featuresStore.volumeUsageEnabled);
const personalEnabled = computed(() => featuresStore.personalEnabled);
const volumes = computed(() => volumeUsageStore.volumes);
const usage = computed(() => volumeUsageStore.usage);
const loading = computed(
  () => volumeUsageStore.isLoadingVolumes || !volumeUsageStore.hasLoadedVolumes
);

onMounted(async () => {
  await Promise.all([favoritesStore.ensureLoaded(), featuresStore.ensureLoaded()]);
  await volumeUsageStore.loadVolumes();
});

const ICON_VARIANTS = {
  outline: OutlineIcons,
  solid: SolidIcons,
};

const resolveIconComponent = (iconName) => {
  if (typeof iconName !== 'string') {
    return OutlineIcons.StarIcon;
  }
  const trimmed = iconName.trim();
  if (!trimmed) return OutlineIcons.StarIcon;
  if (trimmed.includes(':')) {
    const [variantRaw, iconRaw] = trimmed.split(':', 2);
    const variantKey = variantRaw.toLowerCase();
    const iconKey = iconRaw.trim();
    const registry = ICON_VARIANTS[variantKey];
    if (registry && registry[iconKey]) return registry[iconKey];
  }
  return OutlineIcons[trimmed] || SolidIcons[trimmed] || OutlineIcons.StarIcon;
};

const quickAccess = computed(() =>
  favoritesStore.favorites.map((favorite) => {
    const autoLabel = favorite.path.split('/').pop() || favorite.path;
    return {
      ...favorite,
      label: favorite.label || autoLabel,
      iconComponent: resolveIconComponent(favorite.icon),
      color: favorite.color || null,
    };
  })
);

const handleOpenFavorite = (favorite) => {
  if (!favorite?.path) return;
  openBreadcrumb(favorite.path);
};

const PersonalIcon = OutlineIcons.FolderIcon || SolidIcons.FolderIcon;

const openPersonal = () => {
  openBreadcrumb('personal');
};
</script>

<template>
  <div class="flex flex-col gap-8 px-8">
    <!-- Quick Access -->
    <section>
      <h3
        class="mt-6 mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
      >
        {{ $t('volumes.quickAccess') }}
      </h3>
      <div
        v-if="quickAccess.length"
        class="grid grid-cols-2 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
      >
        <button
          v-for="fav in quickAccess"
          :key="fav.path"
          type="button"
          :title="fav.label"
          @click="handleOpenFavorite(fav)"
          class="flex items-center gap-3 py-4 rounded-md cursor-pointer select-none text-neutral-700 dark:text-neutral-300"
        >
          <component
            :is="fav.iconComponent"
            class="h-12 shrink-0"
            :style="{ color: fav.color || 'currentColor' }"
          />
          <div class="text-sm text-left break-all line-clamp-2 rounded-md px-2 -mx-2">
            {{ fav.label }}
          </div>
        </button>
      </div>
      <div v-else class="text-xs">
        {{ $t('volumes.quickAccessEmpty') }}
      </div>
    </section>

    <!-- Volumes -->
    <section>
      <h3
        class="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
      >
        {{ $t('titles.locations') }}
      </h3>
      <div
        v-if="!loading"
        class="grid grid-cols-2 items-start gap-x-2 gap-y-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
      >
        <button
          v-for="vol in volumes"
          :key="vol.name"
          type="button"
          @click="openItem(vol)"
          class="grid w-fit max-w-full grid-cols-[4rem_minmax(0,9rem)] items-start gap-x-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-neutral-100/70 dark:hover:bg-neutral-800/60"
        >
          <IconDrive class="h-16 shrink-0" />
          <div class="flex w-full min-w-0 flex-col items-stretch gap-2 pt-1">
            <div
              class="w-full truncate !text-left text-sm font-medium text-neutral-900 dark:text-white"
              style="text-align: left"
            >
              {{ vol.name }}
            </div>
            <VolumeUsageBar
              v-if="showVolumeUsage"
              :usage="usage[vol.path]"
              :loading="volumeUsageStore.isLoadingUsage"
              percent-inside
              class="w-full"
            />
          </div>
        </button>
      </div>
      <div v-else class="text-sm text-neutral-500 dark:text-neutral-400">
        {{ $t('loading.volumes') }}
      </div>
    </section>

    <!-- Personal -->
    <section v-if="personalEnabled">
      <h3
        class="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
      >
        {{ $t('drives.personal') }}
      </h3>
      <div v-if="!loading">
        <button type="button" @click="openPersonal" class="flex items-center gap-3 py-4 text-left">
          <component :is="PersonalIcon" class="h-14 w-16 shrink-0" />
          <div>
            <div class="mb-1 truncate text-sm font-medium text-neutral-900 dark:text-white">
              {{ $t('drives.myfiles') }}
            </div>
          </div>
        </button>
      </div>
      <div v-else class="text-sm text-neutral-500 dark:text-neutral-400">
        {{ $t('loading.volumes') }}
      </div>
    </section>
  </div>
</template>
