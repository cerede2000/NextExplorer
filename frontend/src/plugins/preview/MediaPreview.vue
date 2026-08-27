<template>
  <div v-if="currentMedia" class="fixed inset-0 z-2000 flex flex-col bg-black text-white">
    <header
      class="flex shrink-0 items-center gap-3 border-b border-white/15 bg-black/80 px-3 py-2 backdrop-blur-sm"
    >
      <h2 class="min-w-0 flex-1 truncate text-sm font-medium">{{ currentMedia.item.name }}</h2>
      <span v-if="mediaItems.length > 1" class="text-xs text-neutral-300" aria-live="polite">
        {{ currentIndex + 1 }} / {{ mediaItems.length }}
      </span>
      <button
        v-if="api.download"
        type="button"
        class="rounded-md p-2 text-neutral-200 transition hover:bg-white/15 hover:text-white"
        :aria-label="t('mediaPreview.download')"
        @click="downloadCurrent"
      >
        <ArrowDownTrayIcon class="h-5 w-5" />
      </button>
      <button
        type="button"
        class="rounded-md p-2 text-neutral-200 transition hover:bg-white/15 hover:text-white"
        :aria-label="t('mediaPreview.close')"
        @click="close"
      >
        <XMarkIcon class="h-5 w-5" />
      </button>
    </header>

    <main
      ref="stageRef"
      class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2"
      data-test="media-preview"
      :style="{ touchAction: zoom.isZoomed.value ? 'none' : 'pan-y' }"
      @pointerdown.capture="startSwipe"
      @pointerup.capture="finishSwipe"
      @pointercancel.capture="resetSwipe"
      @touchstart.capture="startTouchSwipe"
      @touchmove.capture="moveTouch"
      @touchend.capture="finishTouchSwipe"
      @touchcancel.capture="resetSwipe"
      @wheel="handleWheel"
      @dblclick="canZoom && zoom.toggle(stageBounds())"
    >
      <button
        v-if="mediaItems.length > 1"
        type="button"
        class="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white shadow-sm transition hover:bg-black/80"
        :aria-label="t('mediaPreview.previous')"
        @pointerdown.stop
        @click.stop="previous"
      >
        <ChevronLeftIcon class="h-6 w-6" />
      </button>

      <img
        v-if="isPreviewableImage(currentMedia.extension)"
        :src="currentMedia.previewUrl"
        :alt="currentMedia.item.name"
        class="max-h-full max-w-full object-contain"
        :class="zoom.isZoomed.value ? 'cursor-grab' : ''"
        draggable="false"
        :style="{
          touchAction: zoom.isZoomed.value ? 'none' : 'pan-y',
          transform: zoom.transform.value,
          transformOrigin: 'center center',
        }"
        @dragstart.prevent
      />
      <div v-else class="relative max-h-full max-w-full">
        <video
          :key="currentMedia.key"
          ref="videoRef"
          class="block max-h-full max-w-full bg-black"
          controls
          autoplay
          playsinline
          :poster="currentMedia.item.thumbnail"
          style="touch-action: pan-y"
        >
          <source :src="currentMedia.previewUrl" :type="getVideoMimeType(currentMedia.extension)" />
          Your browser does not support the video tag.
        </video>
        <div
          class="absolute inset-x-0 top-0 bottom-14"
          aria-hidden="true"
          style="touch-action: pan-y"
        ></div>
      </div>

      <button
        v-if="mediaItems.length > 1"
        type="button"
        class="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white shadow-sm transition hover:bg-black/80"
        :aria-label="t('mediaPreview.next')"
        @pointerdown.stop
        @click.stop="next"
      >
        <ChevronRightIcon class="h-6 w-6" />
      </button>
    </main>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ArrowDownTrayIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline';
import { isPreviewableImage, isPreviewableVideo } from '@/config/media';
import { useMediaZoom } from './useMediaZoom';

const { t } = useI18n();

const props = defineProps({
  item: { type: Object, required: true },
  extension: { type: String, required: true },
  filePath: { type: String, required: true },
  previewUrl: { type: String, required: true },
  api: { type: Object, required: true },
});

const SWIPE_THRESHOLD = 48;
// Two taps further apart than this are two taps, not a double tap.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 30;
// A trackpad pinch arrives as a wheel event with ctrlKey; this turns its
// delta into a factor gentle enough to be controllable.
const WHEEL_ZOOM_SENSITIVITY = 0.005;

const swipeStart = ref(null);
const videoRef = ref(null);
const stageRef = ref(null);
const zoom = useMediaZoom();
const pinchStart = ref(null);
const lastTap = ref(null);

const stageBounds = () => stageRef.value?.getBoundingClientRect() || null;

const touchDistance = (touches) => {
  const [first, second] = touches;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
};

const getItemKey = (item) => `${item.path || ''}/${item.name || ''}`;

const getItemExtension = (item) => {
  const name = String(item?.name || '');
  const dot = name.lastIndexOf('.');
  if (dot > 0) return name.slice(dot + 1).toLowerCase();

  const kind = String(item?.kind || '').toLowerCase();
  return kind === 'directory' ? '' : kind;
};

const isPreviewableMedia = (item) => {
  const extension = getItemExtension(item);
  return isPreviewableImage(extension) || isPreviewableVideo(extension);
};

const mediaItems = computed(() => {
  const siblings = props.api.getSiblings(props.item);
  const items = Array.isArray(siblings) ? siblings.filter(isPreviewableMedia) : [];
  const currentItemKey = getItemKey(props.item);

  if (!items.some((item) => getItemKey(item) === currentItemKey)) {
    items.unshift(props.item);
  }

  return items
    .map((item) => {
      const key = getItemKey(item);
      const isCurrentItem = key === currentItemKey;
      return {
        key,
        item,
        extension: isCurrentItem ? props.extension.toLowerCase() : getItemExtension(item),
        previewUrl: isCurrentItem ? props.previewUrl : props.api.getPreviewUrl(item),
      };
    })
    .filter((item) => item.previewUrl);
});

const activeMediaKey = ref(getItemKey(props.item));

const currentIndex = computed(() => {
  const index = mediaItems.value.findIndex((item) => item.key === activeMediaKey.value);
  return index >= 0 ? index : 0;
});

const currentMedia = computed(() => mediaItems.value[currentIndex.value] || null);

/** Videos keep their own controls; only pictures zoom. */
const canZoom = computed(
  () => Boolean(currentMedia.value) && isPreviewableImage(currentMedia.value.extension)
);

watch(
  mediaItems,
  (items) => {
    if (!items.some((item) => item.key === activeMediaKey.value)) {
      activeMediaKey.value = items[0]?.key || '';
    }
  },
  { immediate: true }
);

watch(
  () => props.item,
  (item) => {
    activeMediaKey.value = getItemKey(item);
  }
);

const pauseVideo = () => {
  if (!videoRef.value) return;

  videoRef.value.pause();
  videoRef.value.currentTime = 0;
};

watch(currentMedia, (nextMedia, previousMedia) => {
  if (previousMedia?.key !== nextMedia?.key) {
    pauseVideo();
    // A new picture starts at natural size — carrying the previous one's zoom
    // over would land somewhere arbitrary in an unrelated image.
    zoom.reset();
  }
});

const move = (offset) => {
  const { length } = mediaItems.value;
  if (length < 2) return;

  const nextIndex = (currentIndex.value + offset + length) % length;
  activeMediaKey.value = mediaItems.value[nextIndex].key;
};

const previous = () => move(-1);
const next = () => move(1);

const startSwipe = (event) => {
  if (event.pointerType === 'mouse' || event.pointerType === 'touch') return;

  swipeStart.value = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  };
};

const startTouchSwipe = (event) => {
  // Two fingers are never a swipe — on a picture they pinch, and on a video
  // they do nothing at all. Letting one of them arm the swipe would turn a
  // pinch on a video into a page turn.
  if (event.touches?.length === 2) {
    swipeStart.value = null;
    pinchStart.value = canZoom.value
      ? { distance: touchDistance(event.touches), scale: zoom.scale.value }
      : null;
    return;
  }

  const touch = event.changedTouches[0];
  if (!touch) return;

  swipeStart.value = {
    pointerId: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
    // Panning a zoomed picture moves it under the finger, so each move is
    // measured from the last rather than from where the gesture began.
    lastX: touch.clientX,
    lastY: touch.clientY,
  };
};

const moveTouch = (event) => {
  if (pinchStart.value && event.touches?.length === 2) {
    event.preventDefault();
    const distance = touchDistance(event.touches);
    if (pinchStart.value.distance > 0) {
      zoom.zoomTo((pinchStart.value.scale * distance) / pinchStart.value.distance, stageBounds());
    }
    return;
  }

  // One finger on a zoomed picture moves the picture. At natural size it is
  // left alone, so the gallery can read it as a swipe when it ends.
  const start = swipeStart.value;
  if (!start || !zoom.isZoomed.value) return;

  const touch = Array.from(event.touches || []).find((item) => item.identifier === start.pointerId);
  if (!touch) return;

  event.preventDefault();
  zoom.panBy(touch.clientX - start.lastX, touch.clientY - start.lastY, stageBounds());
  start.lastX = touch.clientX;
  start.lastY = touch.clientY;
};

/** Two quick taps in the same spot zoom in, or all the way back out. */
const registerTap = (touch) => {
  if (!canZoom.value || !touch) return false;

  const now = Date.now();
  const previous = lastTap.value;
  lastTap.value = { at: now, x: touch.clientX, y: touch.clientY };

  if (
    previous &&
    now - previous.at < DOUBLE_TAP_MS &&
    Math.abs(touch.clientX - previous.x) < DOUBLE_TAP_SLOP &&
    Math.abs(touch.clientY - previous.y) < DOUBLE_TAP_SLOP
  ) {
    lastTap.value = null;
    zoom.toggle(stageBounds());
    return true;
  }

  return false;
};

/** A trackpad pinch, or ctrl with a wheel — the desktop way in. */
const handleWheel = (event) => {
  if (!canZoom.value || !event.ctrlKey) return;
  event.preventDefault();
  zoom.zoomBy(Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), stageBounds());
};

const resetSwipe = () => {
  swipeStart.value = null;
  pinchStart.value = null;
};

const navigateForSwipe = (start, event) => {
  // Zoomed in, the same movement was panning the picture and must not also
  // turn the page — that conflation is what made the old viewer unusable.
  if (zoom.isZoomed.value) return false;

  const deltaX = event.clientX - start.x;
  const deltaY = event.clientY - start.y;

  if (Math.abs(deltaX) < SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) {
    return false;
  }

  if (deltaX < 0) {
    next();
  } else {
    previous();
  }

  return true;
};

const finishSwipe = (event) => {
  if (event.pointerType === 'touch') return;

  const start = swipeStart.value;
  resetSwipe();

  if (!start || event.pointerId !== start.pointerId) return;
  navigateForSwipe(start, event);
};

const finishTouchSwipe = (event) => {
  if (pinchStart.value && (event.touches?.length ?? 0) < 2) {
    pinchStart.value = null;
    return;
  }

  const start = swipeStart.value;
  const touch = Array.from(event.changedTouches || []).find(
    (item) => item.identifier === start?.pointerId
  );
  resetSwipe();

  if (!start || !touch) return;

  const travelled = Math.hypot(touch.clientX - start.x, touch.clientY - start.y);
  if (travelled < DOUBLE_TAP_SLOP && registerTap(touch)) return;

  navigateForSwipe(start, touch);
};

const getVideoMimeType = (extension) => {
  const types = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
    avi: 'video/x-msvideo',
  };
  return types[extension] || 'video/mp4';
};

const close = () => {
  props.api.close();
};

const downloadCurrent = () => {
  props.api.download(currentMedia.value?.item);
};

const originatedFromVideo = (event) => {
  if (event.target === videoRef.value) return true;
  return event.composedPath?.().includes(videoRef.value) ?? false;
};

const handleKeydown = (event) => {
  if (originatedFromVideo(event)) return;

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    previous();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    next();
  } else if (event.key === 'Escape') {
    close();
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  pauseVideo();
  window.removeEventListener('keydown', handleKeydown);
});
</script>
