import { computed } from 'vue';
import { useStorage } from '@vueuse/core';
import router from '@/router';
import { copyItems, moveItems, normalizePath } from '@/api';
import { folderRoute } from '@/utils/folderRoute';
import { collectTransferredNames, isAbortError, itemKey, serializeItems } from './items';

/**
 * The clipboard, and the copies and moves it leads to.
 *
 * @param {object} options
 * @param {import('vue').Ref<string>} options.currentPath
 * @param {ReturnType<import('./selection').createSelection>} options.selection
 * @param {(path: string) => Promise<unknown>} options.fetchPathItems
 * @param {() => void} options.refreshSizes  volume usage and folder sizes, later
 * @param {object} options.operationTasksStore
 * @param {(items: Array, action: string) => boolean} options.warn
 * @param {(result: object) => boolean} [options.sayWhatWasNotRead]  tells the
 *   reader how many entries a transfer could not read, so a copy short of
 *   files is never reported as finished
 */
export const createTransfers = ({
  currentPath,
  selection,
  fetchPathItems,
  refreshSizes,
  operationTasksStore,
  warn,
  sayWhatWasNotRead = () => false,
}) => {
  const copiedItems = useStorage('nextExplorer_clipboard_copied', []);
  const cutItems = useStorage('nextExplorer_clipboard_cut', []);
  // When true, a finished copy/move re-focuses the pasted entry in its destination
  // folder (navigating there via the router so the address bar stays in sync).
  // When false, the current view is left untouched — handy for launching a long
  // transfer and continuing to browse elsewhere. Persisted across sessions.
  const repositionAfterTransfer = useStorage('nextExplorer_paste_reposition', true);

  const hasClipboardItems = computed(
    () => copiedItems.value.length > 0 || cutItems.value.length > 0
  );

  const resetClipboard = () => {
    copiedItems.value = [];
    cutItems.value = [];
  };

  const copy = () => {
    if (!selection.hasSelection.value) return;
    cutItems.value = [];
    copiedItems.value = selection.selectedItems.value.map((item) => ({ ...item }));
  };

  const cut = () => {
    if (!selection.hasSelection.value) return;
    copiedItems.value = [];
    cutItems.value = selection.selectedItems.value.map((item) => ({ ...item }));
  };

  // Refresh the view (and optionally reposition) once a copy/move settles. The
  // address bar is driven by the router, so "repositioning" navigates through the
  // router to keep the URL/breadcrumb in sync with the listing. When repositioning
  // is disabled we only refresh the folder the user is *currently* viewing (which
  // always matches the route), so navigating away mid-transfer is never disrupted.
  const settleAfterTransfer = async (finalDestination, moveSourceParents, pastedNames) => {
    const userLocation = normalizePath(currentPath.value || '');
    const onDestination = userLocation === finalDestination;

    if (repositionAfterTransfer.value) {
      if (onDestination || !finalDestination) {
        // Already at the destination (or destination is the root, which has no
        // routable path): refresh in place and highlight the result. The address
        // bar is already correct, so no navigation is needed.
        await fetchPathItems(userLocation);
        selection.selectItemsByName(pastedNames);
      } else {
        // Elsewhere (navigated away, or pasted into another folder): navigate to
        // the destination and select the entry, which also updates the address bar.
        const firstName = pastedNames[0];
        router
          .push(folderRoute(finalDestination, firstName ? { select: firstName } : undefined))
          .catch(() => {});
      }
      return;
    }

    // Repositioning disabled: leave the user where they are. Refresh only when the
    // current folder was actually affected (it is the destination, or a move source
    // that just lost entries) so its listing stays accurate without any view jump.
    if (onDestination || moveSourceParents.has(userLocation)) {
      await fetchPathItems(userLocation);
    }
  };

  const paste = async (targetPath) => {
    const hasTarget = typeof targetPath === 'string' && targetPath.trim().length > 0;
    const destination = normalizePath(hasTarget ? targetPath : currentPath.value || '');

    const copyPayload = serializeItems(copiedItems.value);
    const movePayload = serializeItems(cutItems.value);
    warn(copiedItems.value, 'Copy');
    warn(cutItems.value, 'Move');
    const moveSourceParents = new Set(movePayload.map((item) => normalizePath(item.path || '')));
    const totalCount = copyPayload.length + movePayload.length;

    // Shown in the panel, stoppable, and fed the operation's own numbers — all
    // three in one place, because the other gesture that starts a transfer needs
    // exactly the same (see `stores/operationTasks`).
    const transfer =
      totalCount > 0
        ? operationTasksStore.startServerOperation({
            type: movePayload.length > 0 && copyPayload.length === 0 ? 'move' : 'copy',
            destination,
            itemCount: totalCount,
          })
        : null;

    try {
      const pastedNames = [];
      let finalDestination = destination;

      if (copiedItems.value.length > 0) {
        if (copyPayload.length > 0) {
          const result = await copyItems(copyPayload, destination, {
            onEvent: transfer?.onEvent,
            onTask: transfer?.onTask,
          });
          sayWhatWasNotRead(result);
          collectTransferredNames(result, pastedNames);
          if (result?.destination != null) finalDestination = normalizePath(result.destination);
        }
        copiedItems.value = [];
      }

      if (cutItems.value.length > 0) {
        if (movePayload.length > 0) {
          const result = await moveItems(movePayload, destination, {
            onEvent: transfer?.onEvent,
            onTask: transfer?.onTask,
          });
          sayWhatWasNotRead(result);
          collectTransferredNames(result, pastedNames);
          if (result?.destination != null) finalDestination = normalizePath(result.destination);
        }
        cutItems.value = [];
      }

      await settleAfterTransfer(finalDestination, moveSourceParents, pastedNames);
      refreshSizes();
    } catch (error) {
      if (!isAbortError(error)) throw error;
      // A cancelled move can leave its source in place. It must no longer look
      // cut in the explorer, while a clipboard selection made after this
      // transfer started must be preserved.
      const cancelledMoveKeys = new Set(movePayload.map((item) => itemKey(item)));
      if (cancelledMoveKeys.size > 0) {
        cutItems.value = cutItems.value.filter((item) => !cancelledMoveKeys.has(itemKey(item)));
      }
      await fetchPathItems(currentPath.value);
      refreshSizes();
      return null;
    } finally {
      transfer?.finish();
    }
  };

  /**
   * Move or copy the selection into a folder chosen somewhere else.
   *
   * Goes through the clipboard rather than around it: progress, the cancellable
   * task, the refresh and the repositioning on the transferred entry are all
   * there already and proven. What the person had cut or copied is theirs
   * though, so it is put back afterwards — picking a destination from a menu
   * must not quietly empty their clipboard.
   */
  const transferSelectionTo = async (destination, mode = 'move') => {
    if (!selection.hasSelection.value) return;
    const target = normalizePath(destination || '');
    if (!target) return;

    const previousCopied = copiedItems.value;
    const previousCut = cutItems.value;
    const staged = selection.selectedItems.value.map((item) => ({ ...item }));

    copiedItems.value = mode === 'copy' ? staged : [];
    cutItems.value = mode === 'copy' ? [] : staged;

    try {
      await paste(target);
    } finally {
      copiedItems.value = previousCopied;
      cutItems.value = previousCut;
    }
  };

  return {
    copiedItems,
    cutItems,
    repositionAfterTransfer,
    hasClipboardItems,
    resetClipboard,
    copy,
    cut,
    paste,
    transferSelectionTo,
  };
};
