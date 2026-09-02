<script setup>
import { ref, onMounted } from 'vue';
import { useShareList } from '@/composables/shareList';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { formatLocalDateTime } from '@/utils';
import { getSharedWithMe } from '@/api/shares.api';
import { LockClosedIcon, LockOpenIcon, UserIcon } from '@heroicons/vue/24/outline';
import FileIcon from '@/icons/FileIcon.vue';
import ShareListToolbar from '@/components/shares/ShareListToolbar.vue';
import ShareListState from '@/components/shares/ShareListState.vue';

const { t } = useI18n();
const router = useRouter();
const shares = ref([]);
const loading = ref(false);
const error = ref('');

// Grid columns configuration
const GRID_COLS = 'grid-cols-[30px_minmax(0,3fr)_1.5fr_1fr_1.5fr]';

const loadShares = async () => {
  loading.value = true;
  error.value = '';

  try {
    const response = await getSharedWithMe();
    shares.value = response.shares || [];
  } catch (err) {
    console.error('Failed to load shared items:', err);
    error.value = err.message || t('errors.loadShares');
  } finally {
    loading.value = false;
  }
};

const getShareLabel = (share) => {
  if (share.label) {
    return share.label;
  }
  // Fallback to derived source name (leaf folder/file name)
  if (share.sourceName) {
    return share.sourceName;
  }
  return t('share.sharedItem');
};

const getIconItem = (share) => {
  let kind = 'file';
  if (share.isDirectory) {
    kind = 'directory';
  } else {
    const name = share.sourceName || '';
    const parts = name.split('.');
    if (parts.length > 1) {
      kind = parts.pop().toLowerCase();
    }
  }
  return {
    kind,
    name: getShareLabel(share),
    thumbnail: null,
    supportsThumbnail: false,
  };
};

const formatDate = (dateString) => formatLocalDateTime(dateString, t('common.noExpiration'));

// A link you received is found by what it is called or by the file it points
// at, and nothing here records a download, so the most recent thing that can
// have happened is an access, a change, or its creation.
const { filterMode, sortMode, searchQuery, isExpired, visibleShares } = useShareList(shares, {
  labelOf: getShareLabel,
  searchAlso: (share) => share.sourceName,
  recentFields: ['lastAccessedAt', 'updatedAt', 'createdAt'],
});

const handleOpenShare = (share) => {
  if (isExpired(share)) return;

  // Using named route with params ensures proper URL encoding
  router.push({
    name: 'FolderView',
    params: { path: `share/${share.shareToken}` },
  });
};

onMounted(async () => {
  await loadShares();
});
</script>

<template>
  <div class="h-full relative flex flex-col max-h-screen">
    <ShareListToolbar
      v-model:filter-mode="filterMode"
      v-model:sort-mode="sortMode"
      v-model:search-query="searchQuery"
      :title="t('share.sharedWithMe')"
    ></ShareListToolbar>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto px-2">
      <ShareListState
        :loading="loading"
        :error="error"
        :empty="visibleShares.length === 0"
        :empty-text="t('share.noSharedItemsToShow')"
        @retry="loadShares"
      >
        <!-- List -->
        <div class="min-w-[800px]">
          <!-- Header Row -->
          <div
            :class="[
              'grid items-center gap-4 px-4 py-2 text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider border-b border-neutral-100 dark:border-neutral-800 sticky top-0 bg-white dark:bg-default z-10',
              GRID_COLS,
            ]"
          >
            <div></div>
            <div>{{ t('common.name') }}</div>
            <div>{{ t('share.sharedBy') }}</div>
            <div>{{ t('settings.access.title') }}</div>
            <div>{{ t('share.expiresAt') }}</div>
          </div>

          <!-- Items -->
          <div class="flex flex-col gap-0.5 pb-4">
            <div
              v-for="share in visibleShares"
              :key="share.id"
              data-share-row
              @click="handleOpenShare(share)"
              :class="[
                'grid items-center gap-4 px-4 py-2 text-sm rounded-md transition-colors group',
                GRID_COLS,
                isExpired(share)
                  ? 'opacity-60 cursor-not-allowed bg-neutral-50 dark:bg-neutral-900/30'
                  : 'cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800/50',
              ]"
            >
              <!-- Icon -->
              <div class="flex justify-center items-center">
                <FileIcon
                  :item="getIconItem(share)"
                  class="h-12 w-12 shrink-0"
                  :disable-thumbnails="true"
                />
              </div>

              <!-- Name -->
              <div class="min-w-0">
                <div
                  data-share-label
                  class="font-medium text-neutral-900 dark:text-neutral-100 truncate"
                >
                  {{ getShareLabel(share) }}
                </div>
              </div>

              <!-- Shared By -->
              <div class="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
                <UserIcon class="w-4 h-4" />
                <span>{{ t('share.sharedBy') }}</span>
              </div>

              <!-- Access -->
              <div class="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
                <component
                  :is="share.accessMode === 'readonly' ? LockClosedIcon : LockOpenIcon"
                  class="w-4 h-4"
                />
                <span>
                  {{
                    share.accessMode === 'readonly'
                      ? t('settings.access.readOnly')
                      : t('settings.access.readWrite')
                  }}
                </span>
              </div>

              <!-- Expires -->
              <div class="text-neutral-600 dark:text-neutral-300">
                <span :class="{ 'text-red-500': isExpired(share) }">
                  {{ share.expiresAt ? formatDate(share.expiresAt) : t('share.expiresNever') }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </ShareListState>
    </div>
  </div>
</template>
