<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { apiBase } from '@/api';
import { useAppSettings } from '@/stores/appSettings';
import { useFileStore } from '@/stores/fileStore';
import { isPreviewableImage, isPreviewableVideo } from '@/config/media';

import TxtIcon from './files/txt-icon.vue';
import DirectoryIcon from './files/directory-icon.vue';
import CodeIcon from './files/code-icon.vue';
import PdfIcon from './files/pdf-icon.vue';
import FileBadgeIcon from './files/FileBadgeIcon.vue';
import ImageIcon from './files/image-icon.vue';
import VideoIcon from './files/video-icon.vue';
import AudioIcon from './files/audio-icon.vue';
import ArchiveIcon from './files/archive-icon.vue';
import { badgeForExtension } from './fileBadges';

const props = defineProps({
  item: {
    type: Object,
    required: true,
  },
  // Add prop to disable thumbnail loading for search results
  disableThumbnails: {
    type: Boolean,
    default: false,
  },
});

const fileStore = useFileStore();
const appSettings = useAppSettings();

const thumbnailUrl = computed(() => {
  // Early exit if thumbnails disabled via prop
  if (props.disableThumbnails) {
    return null;
  }

  // the thumbnaiil is enabled for system and user
  if (appSettings.thumbnailsEnabledForSession === false) {
    return null;
  }

  const kind = (props.item?.kind || '').toLowerCase();
  if (kind === 'pdf') {
    return null;
  }

  // the file supports thumbnail
  if (!props.item?.supportsThumbnail) {
    return null;
  }

  const thumbnailPath = props.item?.thumbnail;
  if (!thumbnailPath) {
    return null;
  }

  if (/^https?:\/\//i.test(thumbnailPath)) {
    return thumbnailPath;
  }

  return `${apiBase}${thumbnailPath}`;
});

const ext = computed(() => (props.item?.kind || '').toLowerCase());

const isPreviewable = computed(() => {
  if (!ext.value) {
    return false;
  }

  if (ext.value === 'pdf') {
    return false;
  }

  return isPreviewableImage(ext.value) || isPreviewableVideo(ext.value);
});

// Track if we've already requested the thumbnail in this component instance
const hasRequestedThumbnail = ref(false);
const iconRoot = ref(null);
const isNearViewport = ref(false);
const thumbnailRetryCount = ref(0);
let thumbnailObserver = null;
let thumbnailRetryTimer = null;

const canRequestThumbnail = computed(() => {
  if (props.disableThumbnails) return false;
  if (!props.item || props.item.kind === 'directory') return false;
  if (!isPreviewable.value) return false;
  if (appSettings.thumbnailsEnabledForSession === false) return false;
  if (props.item.thumbnail) return false;
  // A prior request definitively failed (missing source / unsupported): don't
  // loop on it. A fresh navigation yields a new item object without this flag.
  if (props.item.thumbnailUnavailable) return false;
  return Boolean(props.item.supportsThumbnail);
});

const thumbnailRequestKey = computed(() => {
  if (!props.item) return '';
  return [
    props.item.path || '',
    props.item.name || '',
    props.item.kind || '',
    props.item.size || '',
    props.item.modified || '',
  ].join('::');
});

const clearThumbnailRetry = () => {
  if (thumbnailRetryTimer) {
    clearTimeout(thumbnailRetryTimer);
    thumbnailRetryTimer = null;
  }
};

const scheduleThumbnailRetry = () => {
  clearThumbnailRetry();
  if (!canRequestThumbnail.value || !isNearViewport.value) return;
  if (thumbnailRetryCount.value >= 20) return;

  thumbnailRetryCount.value += 1;
  const delayMs = Math.min(5000, 700 + thumbnailRetryCount.value * 400);
  thumbnailRetryTimer = setTimeout(() => {
    thumbnailRetryTimer = null;
    hasRequestedThumbnail.value = false;
    requestThumbnailIfNeeded();
  }, delayMs);
};

const requestThumbnailIfNeeded = () => {
  if (hasRequestedThumbnail.value) return;
  if (!isNearViewport.value) return;
  if (!canRequestThumbnail.value) return;

  // All conditions met - request thumbnail once
  hasRequestedThumbnail.value = true;
  fileStore.ensureItemThumbnail(props.item).then((thumbnail) => {
    if (thumbnail) {
      clearThumbnailRetry();
      return;
    }
    scheduleThumbnailRetry();
  });
};

const disconnectThumbnailObserver = () => {
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
    thumbnailObserver = null;
  }
};

const observeThumbnailVisibility = async () => {
  await nextTick();
  if (!iconRoot.value) {
    isNearViewport.value = true;
    return;
  }

  if (typeof IntersectionObserver === 'undefined') {
    isNearViewport.value = true;
    return;
  }

  disconnectThumbnailObserver();
  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      isNearViewport.value = entries.some((entry) => entry.isIntersecting);
      if (isNearViewport.value) {
        requestThumbnailIfNeeded();
      } else {
        clearThumbnailRetry();
        hasRequestedThumbnail.value = false;
      }
    },
    { root: null, rootMargin: '300px 0px', threshold: 0.01 }
  );
  thumbnailObserver.observe(iconRoot.value);
};

watch([canRequestThumbnail, isNearViewport], requestThumbnailIfNeeded);

watch(thumbnailRequestKey, () => {
  clearThumbnailRetry();
  hasRequestedThumbnail.value = false;
  isNearViewport.value = false;
  thumbnailRetryCount.value = 0;
  observeThumbnailVisibility();
});

onMounted(observeThumbnailVisibility);
onBeforeUnmount(() => {
  clearThumbnailRetry();
  disconnectThumbnailObserver();
});

// Additional type groupings
const audioExts = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma']);
const archiveExts = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz']);

// Which badge a file gets is a table, and lives as one in ./fileBadges.
const badge = computed(() => badgeForExtension(ext.value));
</script>

<template>
  <span ref="iconRoot" class="block aspect-square">
    <DirectoryIcon v-if="props.item.kind === 'directory'" />
    <PdfIcon v-else-if="props.item.kind === 'pdf'" />
    <div
      v-else-if="thumbnailUrl"
      class="h-full w-full bg-contain bg-center bg-no-repeat"
      :style="{ backgroundImage: `url('${thumbnailUrl}')` }"
    />
    <ImageIcon v-else-if="isPreviewableImage(ext)" />
    <VideoIcon v-else-if="isPreviewableVideo(ext)" />
    <AudioIcon v-else-if="audioExts.has(ext)" />
    <ArchiveIcon v-else-if="archiveExts.has(ext)" />
    <FileBadgeIcon v-else-if="badge" v-bind="badge" />
    <CodeIcon v-else-if="['json', 'vue'].includes(props.item.kind)" />
    <TxtIcon v-else />
  </span>
</template>
