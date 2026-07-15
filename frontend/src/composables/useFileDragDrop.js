import { ref } from 'vue';
import { useFileStore } from '@/stores/fileStore';
import { useVolumeUsageStore } from '@/stores/volumeUsage';
import { useFolderSizeStore } from '@/stores/folderSize';
import { copyItems, moveItems, normalizePath } from '@/api';
import { useInputMode } from '@/composables/useInputMode';
import { useOperationTasksStore } from '@/stores/operationTasks';

// A drag can cross from the file view into the sidebar, where a different
// composable instance handles dragover. Keep the preview state module-wide so
// Option/Alt can still update the same drag image in either destination.
let activeDragImage = null;
let activeCopyBadge = null;

/**
 * Composable for handling file and folder drag and drop operations.
 * Desktop only - will not work on touch devices.
 */
export function useFileDragDrop() {
  const fileStore = useFileStore();
  const volumeUsageStore = useVolumeUsageStore();
  const folderSizeStore = useFolderSizeStore();
  const operationTasksStore = useOperationTasksStore();
  const { isTouchDevice } = useInputMode();
  const isDraggingOver = ref(false);
  const dragOverTarget = ref(null);
  const dragOperation = ref('move');

  const isExternalFileDrag = (event) => {
    const types = event?.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  };

  const isInternalMoveDrag = (event) => {
    const types = event?.dataTransfer?.types;
    if (!types) return false;
    // Our internal drags set application/json and a text/plain fallback for Safari.
    return (
      Array.from(types).includes('application/json') || Array.from(types).includes('text/plain')
    );
  };

  const serializeItems = (items) =>
    (Array.isArray(items) ? items : [])
      .filter((item) => item && item.name && item.kind !== 'volume')
      .map((item) => ({
        name: item.name,
        path: normalizePath(item.path || ''),
        kind: item.kind,
      }));

  const resolveFolderDestination = (targetFolder) => {
    if (targetFolder?.destinationPath) {
      return normalizePath(targetFolder.destinationPath);
    }

    if (!targetFolder || !targetFolder.name) {
      return normalizePath(fileStore.currentPath || '');
    }

    const parent = normalizePath(targetFolder.path || '');
    const combined = parent ? `${parent}/${targetFolder.name}` : targetFolder.name;
    return normalizePath(combined);
  };

  /**
   * Check if drag and drop should be enabled (desktop only)
   */
  const canDragDrop = () => {
    return !isTouchDevice.value;
  };

  // Option on macOS and Alt on Windows/Linux both set altKey. Copy is kept as
  // a modifier rather than a persistent mode, matching Finder and Explorer.
  const isCopyModifierPressed = (event) => Boolean(event?.altKey);

  /**
   * Handle drag start on a file/folder item
   * @param {DragEvent} event - The drag event
   * @param {Object} item - The item being dragged
   */
  const handleDragStart = (event, item) => {
    if (!canDragDrop()) {
      event.preventDefault();
      return;
    }

    // Determine which items to drag
    // If the item is selected, drag all selected items
    // Otherwise, drag just this item
    const selectedItems = fileStore.selectedItems || [];
    const isSelected = selectedItems.some(
      (selected) => selected.name === item.name && selected.path === item.path
    );

    const itemsToDrag = isSelected && selectedItems.length > 0 ? selectedItems : [item];

    // Store the items being dragged in dataTransfer
    const dragData = JSON.stringify(itemsToDrag);
    event.dataTransfer.setData('application/json', dragData);
    // Safari is inconsistent about exposing custom types during dragover/drop, so add a fallback.
    event.dataTransfer.setData('text/plain', dragData);
    // Keep the native cursor in move mode. The actual copy behavior is decided
    // by Option/Alt when dropping, while the application preview shows the +.
    event.dataTransfer.effectAllowed = 'move';

    const copy = isCopyModifierPressed(event);
    activeDragImage = {
      items: itemsToDrag,
      primaryItem: item,
      sourceEl: event.currentTarget,
      copy,
    };

    // Keep the native preview. Besides matching the familiar cursor placement,
    // it lets the browser animate the preview back to its source on a cancelled
    // drag, which is smoother than recreating the complete card ourselves.
    createNativeDragImage(event, activeDragImage);
    updateDragPreviewOperation(event, copy);
  };

  /**
   * Build the native drag preview with its item-count badge.
   * @param {Object} state - Source items, primary item and active operation
   */
  const buildDragPreview = (state) => {
    if (!state) return null;

    const { items, primaryItem, sourceEl } = state;
    const count = items.length;
    const dragImage = document.createElement('div');
    dragImage.className = 'file-drag-image';

    const stack = document.createElement('div');
    stack.className = 'file-drag-stack';
    const stackDepth = Math.min(count, 3);

    let iconNode = null;
    if (sourceEl) {
      const foundIcon =
        sourceEl.querySelector('.block.aspect-square svg') ||
        sourceEl.querySelector('.block.aspect-square') ||
        sourceEl.querySelector('svg') ||
        sourceEl.querySelector('.bg-contain');
      if (foundIcon) {
        iconNode = foundIcon.cloneNode(true);
        iconNode.style.width = '24px';
        iconNode.style.height = '24px';
        iconNode.classList.remove('w-full', 'h-full', 'w-16', 'h-16', 'w-6', 'h-6');
      }
    }

    for (let i = 0; i < stackDepth; i++) {
      const card = document.createElement('div');
      card.className = 'file-drag-card';

      const offset = (stackDepth - 1 - i) * 8;
      card.style.marginLeft = `${offset}px`;
      card.style.marginTop = `${offset}px`;
      card.style.zIndex = i + 1;

      const iconContainer = document.createElement('div');
      iconContainer.className = 'flex shrink-0 items-center justify-center w-6 h-6';
      if (iconNode) {
        iconContainer.appendChild(iconNode.cloneNode(true));
      } else {
        // Fallback placeholder
        iconContainer.innerHTML = '<div class="w-4 h-4 bg-gray-400 rounded"></div>';
      }
      card.appendChild(iconContainer);
      const label = document.createElement('span');
      label.className = 'truncate text-sm font-medium';
      if (i === stackDepth - 1) {
        label.textContent = primaryItem.name;
      } else {
        label.textContent = items[i] && items[i].name ? items[i].name : primaryItem.name;
      }
      card.appendChild(label);

      stack.appendChild(card);
    }

    dragImage.appendChild(stack);
    const badge = document.createElement('div');
    badge.className = 'file-drag-badge';
    badge.textContent = count.toString();
    dragImage.appendChild(badge);
    return dragImage;
  };

  const createNativeDragImage = (event, state) => {
    if (typeof event?.dataTransfer?.setDragImage !== 'function' || !state) return;

    const dragImage = buildDragPreview(state);
    if (!dragImage) return;
    document.body.appendChild(dragImage);

    // Preserve the original native cursor anchor.
    event.dataTransfer.setDragImage(dragImage, -10, 10);

    const previewWidth = dragImage.getBoundingClientRect().width;
    activeDragImage = {
      ...activeDragImage,
      previewWidth: previewWidth > 0 ? previewWidth : 200,
    };

    window.setTimeout(() => dragImage.remove(), 100);
  };

  const clearCopyBadge = () => {
    activeCopyBadge?.remove();
    activeCopyBadge = null;
  };

  const positionCopyBadge = (event) => {
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    if (!activeCopyBadge || !Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
      return;
    }

    // setDragImage(-10, 10) places the preview at x + 10, y - 10. Its count
    // bubble sits at the upper-right corner; this positions the copy badge
    // immediately to its left without replacing the native preview.
    const previewWidth = Number(activeDragImage?.previewWidth) || 200;
    activeCopyBadge.style.transform = `translate3d(${x + previewWidth - 46}px, ${y - 14}px, 0)`;
  };

  const updateCopyBadge = (event, copy) => {
    if (!copy) {
      clearCopyBadge();
      return;
    }

    if (!activeCopyBadge) {
      activeCopyBadge = document.createElement('div');
      activeCopyBadge.className = 'file-drag-copy-badge file-drag-copy-overlay';
      activeCopyBadge.textContent = '+';
      document.body.appendChild(activeCopyBadge);
    }
    positionCopyBadge(event);
  };

  const updateDragPreviewOperation = (event, copy) => {
    if (!activeDragImage) return;
    activeDragImage = { ...activeDragImage, copy };
    updateCopyBadge(event, copy);
  };

  const handleDragMove = (event) => {
    if (!canDragDrop() || !activeDragImage) return;
    updateDragPreviewOperation(event, isCopyModifierPressed(event));
  };

  /**
   * Handle drag over a folder (potential drop target)
   * @param {DragEvent} event - The drag event
   * @param {Object} targetFolder - The folder being hovered over
   */
  const handleDragOver = (event, targetFolder) => {
    if (!canDragDrop()) return;
    // External file drops should be handled by Uppy DropTarget.
    if (isExternalFileDrag(event)) return;
    if (!isInternalMoveDrag(event)) return;

    event.preventDefault();
    const copy = isCopyModifierPressed(event);
    // Avoid the macOS copy cursor. The green badge in the preview remains the
    // sole operation indicator and the drop still performs a copy when Alt is held.
    event.dataTransfer.dropEffect = 'move';
    updateDragPreviewOperation(event, copy);

    // Store the target folder for drag leave/drop handling
    dragOverTarget.value = targetFolder;
    dragOperation.value = copy ? 'copy' : 'move';
    isDraggingOver.value = true;
  };

  /**
   * Handle drag leave a folder
   * @param {DragEvent} event - The drag event
   * @param {Object} targetFolder - The folder being left
   */
  const handleDragLeave = (event, targetFolder) => {
    if (!canDragDrop()) return;
    if (isExternalFileDrag(event)) return;
    if (!isInternalMoveDrag(event)) return;

    // Only clear if we're actually leaving the folder (not just entering a child)
    // Check if the related target is still within the folder
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX;
    const y = event.clientY;

    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      if (isDragTarget(targetFolder)) {
        dragOverTarget.value = null;
        dragOperation.value = 'move';
        isDraggingOver.value = false;
      }
    }
  };

  /**
   * Handle drop on a folder
   * @param {DragEvent} event - The drag event
   * @param {Object} targetFolder - The folder to drop into
   */
  const handleDrop = async (event, targetFolder) => {
    if (!canDragDrop()) return;

    // If this is an external file drop, let Uppy handle it.
    if (isExternalFileDrag(event)) return;
    if (!isInternalMoveDrag(event)) return;

    event.preventDefault();
    event.stopPropagation();

    // Chrome can omit altKey from the terminal drop event. Keep the state that
    // was observed during dragover so Option/Alt reliably selects copy.
    const copy = activeDragImage?.copy === true || isCopyModifierPressed(event);
    updateDragPreviewOperation(event, copy);
    clearCopyBadge();
    activeDragImage = null;
    isDraggingOver.value = false;
    dragOverTarget.value = null;
    dragOperation.value = 'move';

    // Get the dragged items from dataTransfer
    const dragData =
      event.dataTransfer.getData('application/json') || event.dataTransfer.getData('text/plain');
    if (!dragData) return;

    let draggedItems;
    try {
      draggedItems = JSON.parse(dragData);
    } catch {
      return;
    }
    if (!Array.isArray(draggedItems) || draggedItems.length === 0) return;

    // Get the destination path (target folder's full relative path)
    const destination = resolveFolderDestination(targetFolder);

    // Moving an item into its own parent does nothing. Copying there is useful
    // though: it creates the usual "(1)", "(2)" duplicate in the current folder.
    const isCurrentFolderDestination = draggedItems.every(
      (item) => normalizePath(item.path || '') === destination
    );
    if (isCurrentFolderDestination && !copy) return;

    // Validate: prevent dropping a folder into itself
    const isSelfDrop = draggedItems.some(
      (item) => item.name === targetFolder.name && item.path === targetFolder.path
    );

    if (isSelfDrop) {
      console.warn('Cannot drop a folder into itself');
      return;
    }

    // Validate: prevent dropping a folder into its own descendants
    const isDescendantDrop = draggedItems.some((item) => {
      if (item.kind !== 'directory') return false;

      const itemPath = normalizePath(item.path ? `${item.path}/${item.name}` : item.name);
      return Boolean(itemPath) && destination.startsWith(`${itemPath}/`);
    });

    if (isDescendantDrop) {
      console.warn('Cannot drop a folder into its own descendant');
      return;
    }

    try {
      const transferPayload = serializeItems(draggedItems);
      if (transferPayload.length === 0) return;

      const controller = new AbortController();
      const operationId = operationTasksStore.startOperation({
        type: copy ? 'copy' : 'move',
        destination,
        itemCount: transferPayload.length,
        cancellable: true,
        cancel: () => controller.abort(),
      });

      const onTransferEvent = (streamEvent) => {
        if (!streamEvent) return;
        if (streamEvent.type === 'start') {
          operationTasksStore.updateOperation(operationId, {
            totalBytes: Number(streamEvent.totalBytes) || 0,
            copiedBytes: 0,
          });
        } else if (streamEvent.type === 'progress') {
          operationTasksStore.updateOperation(operationId, {
            ...(streamEvent.totalBytes != null
              ? { totalBytes: Number(streamEvent.totalBytes) || 0 }
              : {}),
            copiedBytes: Number(streamEvent.copiedBytes) || 0,
            ...(streamEvent.percent != null
              ? { percent: Number(streamEvent.percent) || 0 }
              : {}),
          });
        }
      };

      try {
        const transfer = copy ? copyItems : moveItems;
        await transfer(transferPayload, destination, {
          signal: controller.signal,
          onEvent: onTransferEvent,
        });
      } finally {
        operationTasksStore.finishOperation(operationId);
      }

      // Refresh the current path to show the changes
      await fileStore.fetchPathItems(fileStore.currentPath);
      volumeUsageStore.scheduleRefresh();
      folderSizeStore.scheduleRefresh();
    } catch (error) {
      if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
        await fileStore.fetchPathItems(fileStore.currentPath);
        volumeUsageStore.scheduleRefresh();
        folderSizeStore.scheduleRefresh();
        return;
      }
      console.error(`Failed to ${copy ? 'copy' : 'move'} items:`, error);
    }
  };

  const handleDragEnd = () => {
    clearCopyBadge();
    activeDragImage = null;
    isDraggingOver.value = false;
    dragOverTarget.value = null;
    dragOperation.value = 'move';
  };

  /**
   * Check if a folder is currently being dragged over
   * @param {Object} folder - The folder to check
   * @returns {boolean} True if this folder is the drag target
   */
  const isDragTarget = (folder) => {
    if (!dragOverTarget.value) return false;
    return resolveFolderDestination(dragOverTarget.value) === resolveFolderDestination(folder);
  };

  const isCopyDragTarget = (folder) => isDragTarget(folder) && dragOperation.value === 'copy';

  return {
    isDraggingOver,
    canDragDrop,
    handleDragStart,
    handleDragMove,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
    isDragTarget,
    isCopyDragTarget,
  };
}
