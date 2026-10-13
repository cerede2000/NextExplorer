import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { createRateMeter } from '@/utils/transferRate';
import { cancelOperationTask, fetchOperationTasks, watchOperationTask } from '@/api/tasks.api';

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

  /**
   * Hold an operation where it is, and let it go again.
   *
   * Only an operation that says it can be paused is: a chunked upload keeps its
   * place in the file and picks it up, while a direct one has nowhere to pick up
   * from and a copy on the server is not ours to stop. The flag sits beside
   * `cancellable` for the same reason — the panel asks the operation what it can
   * do rather than guessing from its type.
   *
   * The flag is set before the call and put back if the call throws, so a pause
   * that did not happen is not shown as one that did.
   */
  const pauseOperation = (id) => {
    const operation = operations.value.find((entry) => entry.id === id);
    if (!operation?.pausable || operation.paused || operation.cancelling) return;

    updateOperation(id, { paused: true });
    try {
      operation.pause?.();
    } catch (_) {
      updateOperation(id, { paused: false });
    }
  };

  const resumeOperation = (id) => {
    const operation = operations.value.find((entry) => entry.id === id);
    if (!operation?.pausable || !operation.paused) return;

    updateOperation(id, { paused: false });
    try {
      operation.resume?.();
    } catch (_) {
      updateOperation(id, { paused: true });
    }
  };

  /**
   * The operations the server is carrying for this reader, taken into the panel.
   *
   * A copy or a move runs in the server now, so closing the tab no longer stops
   * one — and a tab opened afterwards would otherwise show nothing at all while
   * twenty gigabytes went on moving. So it asks, and follows what it finds from
   * wherever each one has got to.
   *
   * Kept by task id as well as by operation id: the same operation must not be
   * adopted twice, which is what a second look would do.
   */
  const adoptedByTask = new Map();
  const settledListeners = new Set();

  /** Called when an operation that was adopted ends, however it ends. */
  const whenAdoptedSettles = (listener) => {
    settledListeners.add(listener);
    return () => settledListeners.delete(listener);
  };

  const announceSettled = (report) => {
    for (const listener of [...settledListeners]) {
      try {
        listener(report);
      } catch (_) {
        /* one listener's failure is not the operation's */
      }
    }
  };

  /**
   * A figure, or nothing at all.
   *
   * An event says what it knows and leaves out what it does not, and a figure
   * that is not a number is not a figure: read as one it would draw a bar at
   * zero and call that progress.
   */
  const figure = (value) => {
    if (value == null) return null;
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  };

  const numbersOf = (event) => {
    const next = {};
    const totalBytes = figure(event.totalBytes);
    if (totalBytes != null) next.totalBytes = totalBytes;
    const copiedBytes = figure(event.copiedBytes);
    if (copiedBytes != null) next.copiedBytes = copiedBytes;
    const totalItems = figure(event.totalItems);
    if (totalItems != null) next.itemCount = totalItems;
    const percent = figure(event.percent);
    if (percent != null) next.percent = percent;
    return next;
  };

  /**
   * An operation this tab is starting in the server, registered so the panel can
   * show it and so the reader can stop it.
   *
   * Every long operation goes through here — a copy, a move, a deletion, an
   * archive unpacked or packed, something brought back out of the trash — and
   * each needs the same three things: a bar, the operation's own figures folded
   * into it, and a cancel that asks the server rather than hanging up. Written
   * once, because hanging up no longer stops anything: the work runs in the
   * server, so a cancel button wired to an abort is one that silently does
   * nothing, which is what two of these gestures had.
   *
   * The operation is named a moment after it starts — its id arrives with the
   * first event — so a cancel pressed inside that moment is remembered and sent
   * as soon as there is something to send it about.
   */
  const startServerOperation = ({ type, destination, itemCount, name }) => {
    let runningTask = null;
    let stopAsked = false;
    const askTheServer = (taskId) => cancelOperationTask(taskId).catch(() => {});

    const id = startOperation({
      type,
      destination,
      itemCount,
      ...(name ? { name } : {}),
      cancellable: true,
      cancel: () => {
        if (!runningTask) {
          stopAsked = true;
          return;
        }
        askTheServer(runningTask);
      },
    });

    return {
      id,
      /** The operation the server registered for this transfer. */
      onTask: (taskId) => {
        runningTask = taskId || null;
        if (!runningTask) return;
        updateOperation(id, { taskId: runningTask });
        if (stopAsked) askTheServer(runningTask);
      },
      onEvent: (event) => {
        if (event?.type !== 'start' && event?.type !== 'progress') return;
        const updates = {
          ...numbersOf(event),
          // The name an archive really takes is decided while it is written, so
          // the operation corrects it rather than leaving what was asked for.
          ...(typeof event.name === 'string' && event.name ? { name: event.name } : {}),
        };
        if (Object.keys(updates).length > 0) updateOperation(id, updates);
      },
      finish: () => finishOperation(id),
    };
  };

  /**
   * Put a server operation on screen and follow it.
   *
   * It is already running, so there is nothing to start and nothing to abort
   * here: stopping it is asking the server to, and the stream is only a window —
   * closing this tab again leaves it running, as it should.
   */
  const adoptOperation = (view) => {
    if (!view?.id || adoptedByTask.has(view.id)) return adoptedByTask.get(view.id) || null;
    // One the panel is already showing, because this tab started it: adopting it
    // would draw the same transfer twice, with two bars and two cancel buttons.
    const alreadyShown = operations.value.find((entry) => entry.taskId === view.id);
    if (alreadyShown) return alreadyShown.id;

    const operationId = startOperation({
      type: view.kind,
      destination: view.destination,
      ...(view.name ? { name: view.name } : {}),
      itemCount: Number(view.totalItems) || 0,
      totalBytes: Number(view.totalBytes) || 0,
      copiedBytes: Number(view.copiedBytes) || 0,
      percent: view.percent ?? null,
      taskId: view.id,
      adopted: true,
      cancellable: true,
      cancel: () => {
        cancelOperationTask(view.id).catch(() => {});
      },
    });
    adoptedByTask.set(view.id, operationId);

    watchOperationTask(view.id, {
      onEvent: (event) => {
        if (event?.type === 'start' || event?.type === 'progress') {
          updateOperation(operationId, numbersOf(event));
        }
      },
    })
      .then((result) =>
        announceSettled({
          taskId: view.id,
          kind: view.kind,
          destination: view.destination,
          result,
        })
      )
      .catch((error) =>
        announceSettled({ taskId: view.id, kind: view.kind, destination: view.destination, error })
      )
      .finally(() => {
        adoptedByTask.delete(view.id);
        finishOperation(operationId);
      });

    return operationId;
  };

  /**
   * Ask what is running, and what nobody has been told about.
   *
   * Only the running ones are adopted. The rest is news: what a stop was
   * carrying — nothing is resumed across one, by design — and what ended while
   * no window was open on it. Both are handed back for somebody to be told.
   */
  const adoptServerOperations = async () => {
    const { items, interrupted, unreported } = await fetchOperationTasks();
    const adopted = items
      .filter((view) => view.state === 'running')
      .map((view) => adoptOperation(view))
      .filter(Boolean);
    return { adopted, interrupted, unreported };
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
    pauseOperation,
    resumeOperation,
    cancelOperation,
    startServerOperation,
    adoptOperation,
    adoptServerOperations,
    whenAdoptedSettles,
  };
});
