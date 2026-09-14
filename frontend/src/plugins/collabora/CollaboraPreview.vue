<template>
  <div class="h-full w-full bg-white dark:bg-zinc-900">
    <div
      v-if="error"
      class="flex h-full items-center justify-center text-sm text-red-600 dark:text-red-400"
    >
      {{ error }}
    </div>
    <div
      v-else-if="!urlSrc"
      class="flex h-full items-center justify-center text-sm text-neutral-500 dark:text-neutral-400"
    >
      Loading Collabora…
    </div>
    <iframe
      v-else
      ref="iframeRef"
      class="h-full w-full border-0"
      :src="urlSrc"
      :title="title"
      referrerpolicy="no-referrer"
      allow="clipboard-read; clipboard-write"
    />
  </div>
</template>

<script setup>
import { ref, watch, computed } from 'vue';
import { useEventListener } from '@vueuse/core';
import { fetchCollaboraConfig, normalizePath, searchUsersForMention } from '@/api';
import { useVersionsPanelStore } from '@/stores/versionsPanel';
import logger from '@/utils/logger';

const props = defineProps({
  item: { type: Object, required: true },
  extension: { type: String, required: true },
  filePath: { type: String, required: true },
  previewUrl: { type: String, required: true },
  api: { type: Object, required: true },
});

const urlSrc = ref(null);
const error = ref(null);
const iframeRef = ref(null);
const collaboraOrigin = ref(null);
const versionsPanel = useVersionsPanelStore();

const title = computed(() => props?.item?.name || 'Collabora');

// An earlier version, opened from the Versions panel: read, never edited.
const versionId = computed(() =>
  typeof props.item?.versionId === 'string' && props.item.versionId ? props.item.versionId : null
);

/**
 * Send a PostMessage to Collabora iframe
 */
const sendToCollabora = (messageId, values = {}) => {
  const iframe = iframeRef.value;
  if (!iframe?.contentWindow) {
    logger.error('[Collabora] No iframe contentWindow available');
    return;
  }

  const message = {
    MessageId: messageId,
    SendTime: Date.now(),
    Values: values,
  };

  logger.debug('[Collabora] Sending', message);
  iframe.contentWindow.postMessage(JSON.stringify(message), collaboraOrigin.value || '*');
};

/**
 * Handle PostMessage events from Collabora iframe
 */
const handlePostMessage = async (event) => {
  if (!urlSrc.value) return;

  // Store the Collabora origin for sending messages back
  if (!collaboraOrigin.value && event.origin) {
    collaboraOrigin.value = event.origin;
    logger.debug('[Collabora] Origin set to', collaboraOrigin.value);
  }

  let data = event.data;

  logger.debug('[Collabora] Raw PostMessage', data);

  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return;
    }
  }

  logger.debug('[Collabora] Parsed message', data.MessageId, data.Values);

  // When Collabora is ready, send Host_PostmessageReady
  if (data.MessageId === 'App_LoadingStatus' && data.Values?.Status === 'Frame_Ready') {
    logger.debug('[Collabora] Frame ready, sending Host_PostmessageReady');
    sendToCollabora('Host_PostmessageReady');
  }

  // File > Revision history. NextExplorer keeps the history, so the entry opens
  // the Versions panel on this document — only when the editor itself asks, not
  // any other window of the page.
  if (
    data.MessageId === 'UI_FileVersions' &&
    !versionId.value &&
    event.source === iframeRef.value?.contentWindow
  ) {
    versionsPanel.openPath(props.filePath);
  }

  // Handle UI_Mention for @ mentions autocomplete
  if (data.MessageId === 'UI_Mention' && data.Values?.type === 'autocomplete') {
    const searchText = data.Values?.text || '';
    const query = searchText.startsWith('@') ? searchText.slice(1) : searchText;

    logger.debug('[Collabora] Mention autocomplete request, searching for', query);

    try {
      const users = await searchUsersForMention(query);
      logger.debug('[Collabora] Found users', users);

      const mentionList = users.map((user) => ({
        username: user.UserId || user.id,
        profile: '',
        label: user.UserFriendlyName || user.displayName || user.username || user.email,
      }));

      logger.debug('[Collabora] Sending Action_Mention with list', mentionList);
      sendToCollabora('Action_Mention', { list: mentionList });
    } catch (err) {
      logger.error({ err }, '[Collabora] Failed to search users');
    }
  }

  // Log when a mention is selected
  if (data.MessageId === 'UI_Mention' && data.Values?.type === 'selected') {
    logger.debug('[Collabora] User selected mention', data.Values?.username);
  }
};

const load = async () => {
  error.value = null;
  urlSrc.value = null;
  collaboraOrigin.value = null;

  try {
    const filePath = props.filePath;
    if (!filePath) throw new Error('Missing file path.');
    const config = versionId.value
      ? await fetchCollaboraConfig(filePath, 'view', { versionId: versionId.value })
      : await fetchCollaboraConfig(filePath, 'edit');
    urlSrc.value = config?.urlSrc || null;
    if (!urlSrc.value) throw new Error('Missing Collabora iframe URL.');

    // Extract origin from urlSrc
    try {
      const url = new URL(urlSrc.value);
      collaboraOrigin.value = url.origin;
      logger.debug('[Collabora] Extracted origin from URL', collaboraOrigin.value);
    } catch (e) {
      logger.warning('[Collabora] Could not extract origin from URL');
    }
  } catch (e) {
    error.value = e?.message || 'Failed to initialize Collabora.';
  }
};

// Initialize load and set up event listener
load();
useEventListener(window, 'message', handlePostMessage);

watch(
  () => props.filePath,
  () => load()
);

// A version of this document was restored from the panel: the frame still shows
// what the restore replaced, so the document is opened again.
watch(
  () => versionsPanel.restored,
  () => {
    if (versionId.value) return;
    if (normalizePath(versionsPanel.relativePath) !== normalizePath(props.filePath)) return;
    void load();
  }
);
</script>
