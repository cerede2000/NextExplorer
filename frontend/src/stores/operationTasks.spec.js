import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useOperationTasksStore } from '@/stores/operationTasks';

describe('operation task store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('keeps concurrent operations separate and returns to the remaining one', () => {
    const store = useOperationTasksStore();
    const copyId = store.startOperation({ type: 'copy', itemCount: 4 });
    const extractId = store.startOperation({ type: 'extract', name: 'archive.zip' });

    store.updateOperation(copyId, { totalBytes: 100, copiedBytes: 60 });

    expect(store.operationCount).toBe(2);
    expect(store.activeOperation.id).toBe(extractId);
    expect(store.operations.find((operation) => operation.id === copyId)).toMatchObject({
      copiedBytes: 60,
      totalBytes: 100,
    });

    store.finishOperation(extractId);

    expect(store.operationCount).toBe(1);
    expect(store.activeOperation.id).toBe(copyId);
    expect(store.activeOperation.copiedBytes).toBe(60);
  });

  it('keeps the selected operation visible while other operations finish', () => {
    const store = useOperationTasksStore();
    const copyId = store.startOperation({ type: 'copy', itemCount: 1 });
    const compressId = store.startOperation({ type: 'compress', name: 'backup.zip' });

    store.selectOperation(copyId);
    store.finishOperation(compressId);

    expect(store.activeOperation.id).toBe(copyId);
  });

  it('invokes the cancellation handler once and marks the operation as cancelling', () => {
    const store = useOperationTasksStore();
    const cancel = vi.fn();
    const operationId = store.startOperation({ type: 'upload', cancellable: true, cancel });

    store.cancelOperation(operationId);
    store.cancelOperation(operationId);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(store.activeOperation).toMatchObject({ id: operationId, cancelling: true });
  });

  it('holds a transfer that can be held, and lets it go again', () => {
    const store = useOperationTasksStore();
    const pause = vi.fn();
    const resume = vi.fn();
    const operationId = store.startOperation({ type: 'upload', pausable: true, pause, resume });

    store.pauseOperation(operationId);
    // Asked twice: a second press while it is already held must not send a
    // second pause, which for a chunked upload would be a second abort.
    store.pauseOperation(operationId);

    expect(pause).toHaveBeenCalledTimes(1);
    expect(store.activeOperation).toMatchObject({ id: operationId, paused: true });

    store.resumeOperation(operationId);
    store.resumeOperation(operationId);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(store.activeOperation).toMatchObject({ id: operationId, paused: false });
  });

  it('refuses to hold an operation that cannot be held', () => {
    const store = useOperationTasksStore();
    const pause = vi.fn();
    // A direct upload, or a copy the server is making: there is nothing to pick
    // up from, so the panel must not offer it and the store must not pretend.
    const operationId = store.startOperation({ type: 'copy', pause });

    store.pauseOperation(operationId);

    expect(pause).not.toHaveBeenCalled();
    expect(store.activeOperation?.paused).toBeUndefined();
  });

  it('puts the flag back when the transfer refuses to be held', () => {
    const store = useOperationTasksStore();
    const pause = vi.fn(() => {
      throw new Error('the upload had already finished');
    });
    const operationId = store.startOperation({ type: 'upload', pausable: true, pause });

    store.pauseOperation(operationId);

    expect(store.activeOperation).toMatchObject({ id: operationId, paused: false });
  });
});
