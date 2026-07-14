import { beforeEach, describe, expect, it } from 'vitest';
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
});
