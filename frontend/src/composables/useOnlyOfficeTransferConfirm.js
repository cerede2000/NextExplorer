import { computed, ref } from 'vue';

let instance = null;

export function useOnlyOfficeTransferConfirm() {
  if (instance) return instance;

  const isOpen = ref(false);
  const pendingItems = ref([]);
  let resolvePending = null;

  const activeItems = computed(() =>
    pendingItems.value.filter((item) => item?.onlyofficeActivity?.active)
  );

  const requestConfirmation = (items) => {
    const itemsBeingEdited = (Array.isArray(items) ? items : []).filter(
      (item) => item?.onlyofficeActivity?.active
    );
    if (itemsBeingEdited.length === 0) return Promise.resolve(true);

    // A second question replaces the one on screen, and the first must not be
    // left unanswered: whoever is waiting on it is holding a transfer open,
    // for as long as the tab lives. It is answered as refused — nobody said
    // yes to it, and a transfer that does not happen is the safe half of the
    // question this asks.
    if (resolvePending) settle(false);

    pendingItems.value = itemsBeingEdited;
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
    requestConfirmation,
    cancel,
    confirm,
  };
  return instance;
}
