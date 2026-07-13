import { ref } from 'vue';
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

  const serializeSelectedItems = () =>
    actions.selectedItems.value
      .filter((item) => item && item.name && item.kind !== 'volume')
      .map((item) => ({
        name: item.name,
        path: normalizePath(item.path || ''),
        kind: item.kind,
      }));

  const loadDeleteImpact = async () => {
    deleteImpact.value = { shareCount: 0, shares: [] };
    deleteImpactError.value = '';

    const payload = serializeSelectedItems();
    if (payload.length === 0) return;

    isLoadingDeleteImpact.value = true;
    try {
      deleteImpact.value = await getDeleteImpact(payload);
    } catch (err) {
      console.error('Failed to load delete impact', err);
      deleteImpactError.value = err?.message || 'Failed to check linked shares.';
    } finally {
      isLoadingDeleteImpact.value = false;
    }
  };

  const openDeleteConfirm = () => {
    if (!actions.canDelete.value) return;
    isDeleteConfirmOpen.value = true;
    loadDeleteImpact();
  };

  const closeDeleteConfirm = () => {
    isDeleteConfirmOpen.value = false;
  };

  const requestDelete = () => {
    openDeleteConfirm();
  };

  const confirmDelete = async () => {
    if (!actions.canDelete.value || isDeleting.value) return;
    isDeleting.value = true;
    try {
      await actions.deleteNow();
      isDeleteConfirmOpen.value = false;
      deleteImpact.value = { shareCount: 0, shares: [] };
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
    openDeleteConfirm,
    closeDeleteConfirm,
    requestDelete,
    confirmDelete,
  };

  return instance;
}
