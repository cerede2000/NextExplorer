import { computed, ref } from 'vue';
import { useFileActions } from '@/composables/fileActions';
import { getDeleteImpact, normalizePath } from '@/api';

// Singleton instance so multiple callers share the same modal state
let instance = null;

export function useDeleteConfirm() {
  if (instance) return instance;

  const actions = useFileActions();

  const isDeleteConfirmOpen = ref(false);
  const isDeleting = ref(false);
  const isLoadingDeleteImpact = ref(false);
  const deleteImpact = ref({ shareCount: 0, shares: [] });
  const deleteImpactError = ref('');
  const pendingItems = ref([]);
  const pendingDeleteItems = computed(() => pendingItems.value);
  let deleteImpactRequestId = 0;

  const serializeSelectedItems = () =>
    actions.selectedItems.value
      .filter((item) => item && item.name && item.kind !== 'volume')
      .map((item) => ({
        name: item.name,
        path: normalizePath(item.path || ''),
        kind: item.kind,
        // Client-side advisory metadata consumed by fileStore before the
        // request is sent. File APIs intentionally ignore unknown fields.
        onlyofficeActivity: item.onlyofficeActivity || null,
      }));

  const loadDeleteImpact = async (payload = pendingItems.value) => {
    deleteImpact.value = { shareCount: 0, shares: [] };
    deleteImpactError.value = '';

    if (payload.length === 0) return;

    const requestId = ++deleteImpactRequestId;
    isLoadingDeleteImpact.value = true;
    try {
      const impact = await getDeleteImpact(payload);
      if (requestId === deleteImpactRequestId) deleteImpact.value = impact;
    } catch (err) {
      console.error('Failed to load delete impact', err);
      if (requestId === deleteImpactRequestId) {
        deleteImpactError.value = err?.message || 'Failed to check linked shares.';
      }
    } finally {
      if (requestId === deleteImpactRequestId) isLoadingDeleteImpact.value = false;
    }
  };

  const openDeleteConfirm = () => {
    if (!actions.canDelete.value) return;
    const items = serializeSelectedItems();
    if (items.length === 0) return;
    // Keep an immutable selection for this confirmation. The live explorer
    // selection is deliberately cleared when browsing another folder.
    pendingItems.value = items;
    isDeleteConfirmOpen.value = true;
    loadDeleteImpact(items);
  };

  const closeDeleteConfirm = () => {
    deleteImpactRequestId += 1;
    isDeleteConfirmOpen.value = false;
    isLoadingDeleteImpact.value = false;
    pendingItems.value = [];
    deleteImpact.value = { shareCount: 0, shares: [] };
    deleteImpactError.value = '';
  };

  const requestDelete = () => {
    openDeleteConfirm();
  };

  const confirmDelete = async () => {
    if (pendingItems.value.length === 0 || isDeleting.value) return;
    const items = pendingItems.value;
    isDeleting.value = true;
    isDeleteConfirmOpen.value = false;
    try {
      await actions.deleteNow(items, { onlyofficeWarningShown: true });
      closeDeleteConfirm();
    } catch (err) {
      console.error('Delete operation failed', err);
    } finally {
      isDeleting.value = false;
    }
  };

  instance = {
    isDeleteConfirmOpen,
    isDeleting,
    isLoadingDeleteImpact,
    deleteImpact,
    deleteImpactError,
    pendingDeleteItems,
    openDeleteConfirm,
    closeDeleteConfirm,
    requestDelete,
    confirmDelete,
  };

  return instance;
}
