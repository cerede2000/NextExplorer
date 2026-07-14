import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

// File operations can run concurrently (for example an extraction while a ZIP
// is being created). Keep each operation isolated so a new stream never
// replaces the progress state of an earlier one.
export const useOperationTasksStore = defineStore('operationTasks', () => {
  const operations = ref([]);
  const activeOperationId = ref(null);
  let nextOperationId = 0;

  const activeOperation = computed(() => {
    const selected = operations.value.find((operation) => operation.id === activeOperationId.value);
    return selected || operations.value.at(-1) || null;
  });

  const operationCount = computed(() => operations.value.length);

  const startOperation = (operation) => {
    nextOperationId += 1;
    const id = `operation-${Date.now()}-${nextOperationId}`;
    const next = {
      id,
      startedAt: Date.now(),
      totalBytes: 0,
      copiedBytes: 0,
      percent: null,
      ...operation,
    };

    operations.value = [...operations.value, next];
    activeOperationId.value = id;
    return id;
  };

  const updateOperation = (id, updates) => {
    const index = operations.value.findIndex((operation) => operation.id === id);
    if (index < 0) return;

    const next = [...operations.value];
    next[index] = { ...next[index], ...updates };
    operations.value = next;
  };

  const selectOperation = (id) => {
    if (operations.value.some((operation) => operation.id === id)) {
      activeOperationId.value = id;
    }
  };

  const finishOperation = (id) => {
    const wasSelected = activeOperationId.value === id;
    operations.value = operations.value.filter((operation) => operation.id !== id);

    if (wasSelected) {
      activeOperationId.value = operations.value.at(-1)?.id || null;
    }
  };

  return {
    operations,
    activeOperationId,
    activeOperation,
    operationCount,
    startOperation,
    updateOperation,
    selectOperation,
    finishOperation,
  };
});
