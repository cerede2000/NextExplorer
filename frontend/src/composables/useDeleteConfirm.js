import { computed, ref } from 'vue';
import { useFileActions } from '@/composables/fileActions';
import { getDeleteImpact, normalizePath } from '@/api';

// Singleton instance so multiple callers share the same modal state
let instance = null;

const emptyImpact = () => ({ shareCount: 0, shares: [], trash: null });

/** The path the server reports an item under: its folder, then its name. */
const pathOf = (item) => normalizePath(item?.path ? `${item.path}/${item.name}` : item?.name || '');

/**
 * Deleting, with the confirmation that says what will happen.
 *
 * When the trash is on, the server says per item whether it goes there or
 * would be gone for good — another disk, larger than the whole trash, a volume
 * itself. The dialog says so before anyone confirms, and those items are then
 * removed for good in their own request, as announced. The rest go to the
 * trash. Anything the trash still turns away at deletion time (a folder only
 * measured then) is left where it is, and asked about again: a deletion is
 * never permanent without the person having been told.
 */
export function useDeleteConfirm() {
  if (instance) return instance;

  const actions = useFileActions();

  const isDeleteConfirmOpen = ref(false);
  const isDeleting = ref(false);
  const isLoadingDeleteImpact = ref(false);
  const deleteImpact = ref(emptyImpact());
  const deleteImpactError = ref('');
  const pendingItems = ref([]);
  const pendingDeleteItems = computed(() => pendingItems.value);
  const keptItems = ref([]);
  const isKeptConfirmOpen = computed(() => keptItems.value.length > 0);
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
    deleteImpact.value = emptyImpact();
    deleteImpactError.value = '';

    if (payload.length === 0) return;

    const requestId = ++deleteImpactRequestId;
    isLoadingDeleteImpact.value = true;
    try {
      const impact = await getDeleteImpact(payload);
      if (requestId === deleteImpactRequestId) {
        deleteImpact.value = { ...emptyImpact(), ...impact };
      }
    } catch (err) {
      console.error('Failed to load delete impact', err);
      if (requestId === deleteImpactRequestId) {
        deleteImpactError.value = err?.message || 'Failed to check linked shares.';
      }
    } finally {
      if (requestId === deleteImpactRequestId) isLoadingDeleteImpact.value = false;
    }
  };

  /**
   * What the trash will do with the pending items, once the server has said.
   * Null while it has not: the deletion is then sent as is, and the server,
   * which knows, decides.
   */
  const trashPlan = computed(() => {
    const trash = deleteImpact.value?.trash;
    if (!trash) return null;
    const byPath = new Map((trash.items || []).map((entry) => [entry.path, entry]));
    const announced = pendingItems.value.filter(
      (item) => byPath.get(pathOf(item))?.disposition === 'permanent'
    );
    const enabled = Boolean(trash.enabled);
    return {
      enabled,
      retentionDays: Number.isFinite(trash.retentionDays) ? trash.retentionDays : null,
      toTrash: enabled ? pendingItems.value.filter((item) => !announced.includes(item)) : [],
      permanent: enabled ? announced : pendingItems.value,
      reasons: [
        ...new Set(announced.map((item) => byPath.get(pathOf(item))?.reason).filter(Boolean)),
      ],
    };
  });

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
    deleteImpact.value = emptyImpact();
    deleteImpactError.value = '';
  };

  const requestDelete = () => {
    openDeleteConfirm();
  };

  /** The items of a deletion the trash turned away, with why. */
  const collectKept = (response, sent) =>
    (Array.isArray(response?.items) ? response.items : [])
      .filter((result) => result?.status === 'kept')
      .map((result) => {
        const resultPath = normalizePath(result.path || '');
        const item = sent.find((candidate) => pathOf(candidate) === resultPath);
        const segments = resultPath.split('/');
        return {
          name: item?.name || segments.pop(),
          path: item ? item.path : segments.join('/'),
          kind: item?.kind,
          reason: result.reason || null,
          size: Number.isFinite(result.size) ? result.size : null,
          budgetBytes: Number.isFinite(result.budgetBytes) ? result.budgetBytes : null,
        };
      });

  /**
   * Delete what was confirmed. `permanent` sends everything for good — the
   * dialog's second button. Otherwise what the dialog announced as permanent
   * goes for good and the rest to the trash.
   */
  const confirmDelete = async ({ permanent = false } = {}) => {
    if (pendingItems.value.length === 0 || isDeleting.value) return;
    const items = pendingItems.value;
    const plan = trashPlan.value;
    const forGood = permanent === true ? items : plan?.enabled ? plan.permanent : [];
    const toTrash = items.filter((item) => !forGood.includes(item));

    isDeleting.value = true;
    isDeleteConfirmOpen.value = false;
    try {
      const kept = [];
      if (toTrash.length > 0) {
        const response = await actions.deleteNow(toTrash, { onlyofficeWarningShown: true });
        kept.push(...collectKept(response, toTrash));
      }
      if (forGood.length > 0) {
        await actions.deleteNow(forGood, { onlyofficeWarningShown: true, permanent: true });
      }
      closeDeleteConfirm();
      keptItems.value = kept;
    } catch (err) {
      console.error('Delete operation failed', err);
    } finally {
      isDeleting.value = false;
    }
  };

  /** The person saw why the trash could not take these, and chose to remove them for good. */
  const confirmKept = async () => {
    const items = keptItems.value;
    if (items.length === 0 || isDeleting.value) return;
    keptItems.value = [];
    isDeleting.value = true;
    try {
      await actions.deleteNow(
        items.map(({ name, path, kind }) => ({ name, path, kind })),
        { onlyofficeWarningShown: true, permanent: true }
      );
    } catch (err) {
      console.error('Delete operation failed', err);
    } finally {
      isDeleting.value = false;
    }
  };

  const closeKeptConfirm = () => {
    keptItems.value = [];
  };

  instance = {
    isDeleteConfirmOpen,
    isDeleting,
    isLoadingDeleteImpact,
    deleteImpact,
    deleteImpactError,
    pendingDeleteItems,
    trashPlan,
    keptItems,
    isKeptConfirmOpen,
    openDeleteConfirm,
    closeDeleteConfirm,
    requestDelete,
    confirmDelete,
    confirmKept,
    closeKeptConfirm,
  };

  return instance;
}
