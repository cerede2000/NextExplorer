import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const copyItems = vi.fn();
const moveItems = vi.fn();
const fetchPathItems = vi.fn();
const scheduleUsageRefresh = vi.fn();
const scheduleFolderRefresh = vi.fn();
const startOperation = vi.fn(() => 'operation-test');
const updateOperation = vi.fn();
const finishOperation = vi.fn();

const fileStore = {
  currentPath: 'Source',
  selectedItems: [],
  fetchPathItems,
};

vi.mock('@/api', () => ({
  copyItems: (...args) => copyItems(...args),
  moveItems: (...args) => moveItems(...args),
  normalizePath: (value = '') => value.replace(/^\/+|\/+$/g, ''),
}));

vi.mock('@/stores/fileStore', () => ({ useFileStore: () => fileStore }));
vi.mock('@/stores/volumeUsage', () => ({
  useVolumeUsageStore: () => ({ scheduleRefresh: scheduleUsageRefresh }),
}));
vi.mock('@/stores/folderSize', () => ({
  useFolderSizeStore: () => ({ scheduleRefresh: scheduleFolderRefresh }),
}));
vi.mock('@/stores/operationTasks', () => ({
  useOperationTasksStore: () => ({ startOperation, updateOperation, finishOperation }),
}));
vi.mock('@/composables/useInputMode', () => ({
  useInputMode: () => ({ isTouchDevice: ref(false) }),
}));

import { useFileDragDrop } from '@/composables/useFileDragDrop';

const item = { name: 'report.txt', path: 'Source', kind: 'file' };
const target = { name: 'Target', path: 'Volume', kind: 'directory' };

const transferEvent = (overrides = {}) => {
  const payload = JSON.stringify([item]);
  const dataTransfer = {
    types: ['application/json', 'text/plain'],
    dropEffect: 'move',
    getData: vi.fn((type) => (type === 'application/json' ? payload : '')),
    ...overrides.dataTransfer,
  };

  return {
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer,
    ...overrides,
  };
};

describe('useFileDragDrop', () => {
  beforeEach(() => {
    copyItems.mockReset();
    moveItems.mockReset();
    fetchPathItems.mockReset();
    scheduleUsageRefresh.mockReset();
    scheduleFolderRefresh.mockReset();
    startOperation.mockClear();
    updateOperation.mockReset();
    finishOperation.mockReset();
    copyItems.mockResolvedValue({});
    moveItems.mockResolvedValue({});
  });

  it('uses copy for an Option/Alt drop and exposes the copy target state', async () => {
    const dragDrop = useFileDragDrop();
    const event = transferEvent({ altKey: true });

    dragDrop.handleDragOver(event, target);
    expect(event.dataTransfer.dropEffect).toBe('copy');
    expect(dragDrop.isCopyDragTarget(target)).toBe(true);

    await dragDrop.handleDrop(event, target);

    expect(copyItems).toHaveBeenCalledWith(
      [{ name: 'report.txt', path: 'Source', kind: 'file' }],
      'Volume/Target',
      expect.objectContaining({ onEvent: expect.any(Function), signal: expect.any(AbortSignal) })
    );
    expect(moveItems).not.toHaveBeenCalled();
    expect(startOperation).toHaveBeenCalledWith(expect.objectContaining({ type: 'copy' }));
    expect(finishOperation).toHaveBeenCalledWith('operation-test');
  });

  it('moves by default', async () => {
    const dragDrop = useFileDragDrop();
    const event = transferEvent();

    await dragDrop.handleDrop(event, target);

    expect(moveItems).toHaveBeenCalledWith(
      [{ name: 'report.txt', path: 'Source', kind: 'file' }],
      'Volume/Target',
      expect.objectContaining({ onEvent: expect.any(Function), signal: expect.any(AbortSignal) })
    );
    expect(copyItems).not.toHaveBeenCalled();
    expect(startOperation).toHaveBeenCalledWith(expect.objectContaining({ type: 'move' }));
  });

  it('uses a favorite destination path instead of its display label', async () => {
    const dragDrop = useFileDragDrop();
    const event = transferEvent();
    const favoriteTarget = {
      name: 'Inbox',
      path: 'Volume',
      destinationPath: 'Volume/Incoming',
    };

    await dragDrop.handleDrop(event, favoriteTarget);

    expect(moveItems).toHaveBeenCalledWith(
      [{ name: 'report.txt', path: 'Source', kind: 'file' }],
      'Volume/Incoming',
      expect.any(Object)
    );
  });
});
