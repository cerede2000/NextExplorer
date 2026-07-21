import { computed, ref } from 'vue';

let instance = null;

export function useOnlyOfficeTransferConfirm() {
  if (instance) return instance;

  const isOpen = ref(false);
  const pendingItems = ref([]);
  const pendingAction = ref('Le déplacement');
  let resolvePending = null;

  const activeItems = computed(() =>
    pendingItems.value.filter((item) => item?.onlyofficeActivity?.active)
  );

  const requestConfirmation = (items, action) => {
    const itemsBeingEdited = (Array.isArray(items) ? items : []).filter(
      (item) => item?.onlyofficeActivity?.active
    );
    if (itemsBeingEdited.length === 0) return Promise.resolve(true);

    pendingItems.value = itemsBeingEdited;
    pendingAction.value = action;
    isOpen.value = true;

    return new Promise((resolve) => {
      resolvePending = resolve;
    });
  };

  const settle = (confirmed) => {
    if (!resolvePending) return;
    const resolve = resolvePending;
    resolvePending = null;
    isOpen.value = false;
    pendingItems.value = [];
    resolve(confirmed);
  };

  const cancel = () => settle(false);
  const confirm = () => settle(true);

  instance = {
    isOpen,
    activeItems,
    pendingAction,
    requestConfirmation,
    cancel,
    confirm,
  };
  return instance;
}
