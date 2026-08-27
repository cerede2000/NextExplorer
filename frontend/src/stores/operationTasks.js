import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { createRateMeter } from '@/utils/transferRate';

// File operations can run concurrently (for example an extraction while a ZIP
// is being created). Keep each operation isolated so a new stream never
// replaces the progress state of an earlier one.
export const useOperationTasksStore = defineStore('operationTasks', () => {
  const operations = ref([]);
  const activeOperationId = ref(null);
  let nextOperationId = 0;

  // Rate is measured here rather than by each caller, so every operation that
  // reports bytes — uploads, copies, moves — gets the same figure computed the
  // same way. Meters are kept outside the reactive state: they hold a rolling
  // window that changes on every progress event, and nothing renders from it
  // directly.
  const meters = new Map();

  const meterFor = (id) => {
    let meter = meters.get(id);
    if (!meter) {
      meter = createRateMeter();
      meters.set(id, meter);
    }
    return meter;
  };

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

  /**
   * Bytes per second for one operation, or null when there is nothing honest
   * to report — too early, paused, or an operation that only reports a
   * percentage and no byte counts at all (archive extraction, for one).
   */
  const rateFor = (id) => meters.get(id)?.rate() ?? null;

  const updateOperation = (id, updates) => {
    const index = operations.value.findIndex((operation) => operation.id === id);
    if (index < 0) return;

    const previous = operations.value[index];
    const next = [...operations.value];
    next[index] = { ...previous, ...updates };
    operations.value = next;

    sampleRate(previous, next[index], updates);
  };

  /**
   * Feed the meter whichever byte count this operation is currently moving.
   *
   * An upload changes course once its last byte is out: the server is then
   * copying the file into place, a second run of bytes with its own pace. That
   * hand-over needs no special case — the copy starts below the bytes already
   * transferred, and the meter treats a count that goes backwards as a fresh
   * start, exactly as it does for a retried chunk.
   */
  const sampleRate = (previous, current, updates) => {
    if (current.finalizing) {
      const startedFinalizing = !previous.finalizing;
      if (updates.finalizedBytes != null || startedFinalizing) {
        meterFor(current.id).sample(Number(current.finalizedBytes) || 0);
      }
      return;
    }

    if (updates.copiedBytes != null) {
      meterFor(current.id).sample(Number(current.copiedBytes) || 0);
    }
  };

  const selectOperation = (id) => {
    if (operations.value.some((operation) => operation.id === id)) {
      activeOperationId.value = id;
    }
  };

  const finishOperation = (id) => {
    const wasSelected = activeOperationId.value === id;
    meters.delete(id);
    operations.value = operations.value.filter((operation) => operation.id !== id);

    if (wasSelected) {
      activeOperationId.value = operations.value.at(-1)?.id || null;
    }
  };

  const cancelOperation = (id) => {
    const operation = operations.value.find((entry) => entry.id === id);
    if (!operation?.cancellable || operation.cancelling) return;

    updateOperation(id, { cancelling: true });
    try {
      operation.cancel?.();
    } catch (_) {
      updateOperation(id, { cancelling: false });
    }
  };

  return {
    operations,
    activeOperationId,
    activeOperation,
    operationCount,
    startOperation,
    updateOperation,
    rateFor,
    selectOperation,
    finishOperation,
    cancelOperation,
  };
});
