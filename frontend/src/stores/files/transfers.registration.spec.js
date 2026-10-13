import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

/**
 * A paste goes through the panel's own registration, and nothing else.
 *
 * The work runs in the server now, so what a transfer needs on screen — a bar,
 * the operation's own numbers, and a cancel that asks the server rather than
 * hanging up — is written once in `stores/operationTasks` and used by both
 * gestures that start one. This is the paste side of that: the one thing that
 * can go wrong here is a gesture that watches or stops a transfer some other
 * way, which is how the drag onto a folder came to have a cancel button that
 * silently did nothing.
 */

const { copyItems, moveItems } = vi.hoisted(() => ({ copyItems: vi.fn(), moveItems: vi.fn() }));

vi.mock('@/api', () => ({
  copyItems,
  moveItems,
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));
vi.mock('@/router', () => ({ default: { push: vi.fn(() => Promise.resolve()) } }));

const { createTransfers } = await import('@/stores/files/transfers');

const onEvent = vi.fn();
const onTask = vi.fn();
const finish = vi.fn();
const startTransfer = vi.fn(() => ({ id: 'operation-1', onEvent, onTask, finish }));

const transfersWith = ({ cut = false } = {}) => {
  const staged = [{ path: 'Docs', name: 'report.txt' }];
  const transfers = createTransfers({
    currentPath: ref('Docs'),
    selection: {
      hasSelection: ref(true),
      selectedItems: ref(staged),
      selectItemsByName: vi.fn(),
    },
    fetchPathItems: vi.fn(async () => {}),
    refreshSizes: vi.fn(),
    operationTasksStore: { startTransfer },
    warn: () => false,
  });
  transfers.copiedItems.value = cut ? [] : staged;
  transfers.cutItems.value = cut ? staged : [];
  return transfers;
};

beforeEach(() => {
  startTransfer.mockClear();
  onEvent.mockReset();
  onTask.mockReset();
  finish.mockReset();
  copyItems.mockReset();
  moveItems.mockReset();
  copyItems.mockResolvedValue({ destination: 'Archive', items: [] });
  moveItems.mockResolvedValue({ destination: 'Archive', items: [] });
  localStorage.clear();
});

describe('pasting', () => {
  it('registers the transfer, with where it is going and how much of it there is', async () => {
    await transfersWith().paste('Archive');

    expect(startTransfer).toHaveBeenCalledWith({
      type: 'copy',
      destination: 'Archive',
      itemCount: 1,
    });
  });

  it('registers a move as a move', async () => {
    await transfersWith({ cut: true }).paste('Archive');

    expect(startTransfer).toHaveBeenCalledWith(expect.objectContaining({ type: 'move' }));
  });

  it('watches it and names it through that registration, and nothing else', async () => {
    await transfersWith().paste('Archive');

    expect(copyItems).toHaveBeenCalledWith([{ path: 'Docs', name: 'report.txt' }], 'Archive', {
      onEvent,
      onTask,
    });
  });

  it('takes it off the panel when it is over', async () => {
    await transfersWith().paste('Archive');

    expect(finish).toHaveBeenCalled();
  });

  // Including when it was stopped, which arrives as a refusal of its own.
  it('takes it off the panel when it was stopped', async () => {
    const cancelled = new Error('Operation cancelled.');
    cancelled.code = 'OPERATION_CANCELLED';
    copyItems.mockRejectedValue(cancelled);

    await transfersWith().paste('Archive');

    expect(finish).toHaveBeenCalled();
  });

  it('registers nothing when there is nothing on the clipboard', async () => {
    const transfers = transfersWith();
    transfers.copiedItems.value = [];
    transfers.cutItems.value = [];

    await transfers.paste('Archive');

    expect(startTransfer).not.toHaveBeenCalled();
    expect(copyItems).not.toHaveBeenCalled();
  });
});
