import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The operations the server is already carrying, taken into the panel.
 *
 * A copy runs in the server and the response to the request that asked for it is
 * only a window: closing the tab stops nothing. Which left the other half
 * missing — a tab opened afterwards showed nothing at all while twenty gigabytes
 * went on moving — so the panel asks what is running and follows it from wherever
 * it has got to.
 */

const { fetchOperationTasks, watchOperationTask, cancelOperationTask } = vi.hoisted(() => ({
  fetchOperationTasks: vi.fn(),
  watchOperationTask: vi.fn(),
  cancelOperationTask: vi.fn(),
}));

vi.mock('@/api/tasks.api', () => ({
  fetchOperationTasks,
  watchOperationTask,
  cancelOperationTask,
}));

const { useOperationTasksStore } = await import('@/stores/operationTasks');

const running = (overrides = {}) => ({
  id: 'task-1',
  kind: 'copy',
  state: 'running',
  destination: 'Archive/2026',
  totalItems: 3,
  completedItems: 1,
  totalBytes: 900,
  copiedBytes: 300,
  percent: null,
  ...overrides,
});

/**
 * Let the promise chain behind a finished window run out.
 *
 * Waiting a turn is not enough: the end of one is reported, then the bar is
 * taken away, and counting the turns in between is counting the links of a chain
 * this test is not about. So it waits on the clock.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A window that stays open until the test closes it. */
const heldWindow = () => {
  let settle = () => {};
  let fail = () => {};
  let emit = () => {};
  watchOperationTask.mockImplementation((_id, { onEvent }) => {
    emit = onEvent;
    return new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
  });
  return {
    emit: (event) => emit(event),
    finish: (result) => settle(result),
    fail: (error) => fail(error),
  };
};

beforeEach(() => {
  setActivePinia(createPinia());
  fetchOperationTasks.mockReset();
  watchOperationTask.mockReset();
  cancelOperationTask.mockReset();
  cancelOperationTask.mockResolvedValue({ cancelled: true });
  watchOperationTask.mockResolvedValue({ type: 'done', destination: 'Archive/2026' });
  fetchOperationTasks.mockResolvedValue({ items: [], interrupted: [] });
});

/**
 * A transfer this tab starts, registered once for both gestures that start one.
 *
 * The work runs in the server and the request only watches it, so hanging up
 * stops nothing: a cancel wired to an abort is a button that silently does
 * nothing while the copy runs to the end. And the operation is named a moment
 * after it starts, so a cancel pressed inside that moment has to be remembered
 * rather than turned into an abort of the one connection that was about to
 * bring us the name.
 */
describe('a transfer this tab starts', () => {
  it('is shown, and stopped by asking the server about it', () => {
    const store = useOperationTasksStore();
    const transfer = store.startServerOperation({
      type: 'copy',
      destination: 'Archive',
      itemCount: 4,
    });

    expect(store.operations[0]).toMatchObject({
      type: 'copy',
      destination: 'Archive',
      itemCount: 4,
      cancellable: true,
    });

    transfer.onTask('task-5');
    expect(store.operations[0].taskId).toBe('task-5');

    store.cancelOperation(transfer.id);
    expect(cancelOperationTask).toHaveBeenCalledWith('task-5');
  });

  it('is stopped as soon as it has a name, when it had none yet', () => {
    const store = useOperationTasksStore();
    const transfer = store.startServerOperation({
      type: 'move',
      destination: 'Archive',
      itemCount: 1,
    });

    store.cancelOperation(transfer.id);
    expect(cancelOperationTask).not.toHaveBeenCalled();

    transfer.onTask('task-6');
    expect(cancelOperationTask).toHaveBeenCalledWith('task-6');
  });

  it('asks nothing of a server that never named one', () => {
    const store = useOperationTasksStore();
    const transfer = store.startServerOperation({
      type: 'copy',
      destination: 'Archive',
      itemCount: 1,
    });

    transfer.onTask(null);
    store.cancelOperation(transfer.id);

    expect(cancelOperationTask).not.toHaveBeenCalled();
  });

  it('shows the operation\u2019s own numbers, for the whole selection', () => {
    const store = useOperationTasksStore();
    const transfer = store.startServerOperation({
      type: 'copy',
      destination: 'Archive',
      itemCount: 2,
    });

    transfer.onEvent({ type: 'start', totalBytes: 900, totalItems: 3, copiedBytes: 0 });
    transfer.onEvent({ type: 'progress', copiedBytes: 450, totalBytes: 900, totalItems: 3 });

    expect(store.operations[0]).toMatchObject({
      totalBytes: 900,
      copiedBytes: 450,
      itemCount: 3,
    });
  });

  it('comes off the panel when it is finished with', () => {
    const store = useOperationTasksStore();
    const transfer = store.startServerOperation({
      type: 'copy',
      destination: 'Archive',
      itemCount: 1,
    });

    transfer.finish();

    expect(store.operations).toEqual([]);
  });
});

describe('an operation the server is already carrying', () => {
  it('appears in the panel where it has got to, and is followed from there', async () => {
    const store = useOperationTasksStore();
    const open = heldWindow();

    const id = store.adoptOperation(running());

    expect(store.operations).toHaveLength(1);
    expect(store.operations[0]).toMatchObject({
      type: 'copy',
      destination: 'Archive/2026',
      itemCount: 3,
      totalBytes: 900,
      copiedBytes: 300,
      taskId: 'task-1',
      adopted: true,
      cancellable: true,
    });

    open.emit({ type: 'progress', copiedBytes: 600, totalBytes: 900, totalItems: 3 });
    expect(store.operations[0]).toMatchObject({ copiedBytes: 600 });

    open.finish({ type: 'done' });
    await settled();
    expect(store.operations).toHaveLength(0);
    expect(id).toBeTypeOf('string');
  });

  it('is adopted once, however many times it is offered', async () => {
    const store = useOperationTasksStore();
    heldWindow();

    const first = store.adoptOperation(running());
    const again = store.adoptOperation(running());

    expect(again).toBe(first);
    expect(store.operations).toHaveLength(1);
    expect(watchOperationTask).toHaveBeenCalledTimes(1);
  });

  /**
   * Including the one this very tab started. The panel is already showing it,
   * and adopting it would draw the same transfer twice — two bars and two cancel
   * buttons for one copy.
   */
  it('is not adopted when the panel is already showing it', async () => {
    const store = useOperationTasksStore();
    const mine = store.startOperation({ type: 'copy', taskId: 'task-1', itemCount: 3 });

    const adopted = store.adoptOperation(running());

    expect(adopted).toBe(mine);
    expect(store.operations).toHaveLength(1);
    expect(watchOperationTask).not.toHaveBeenCalled();
  });

  // Stopping it is asking the server to, not closing the window onto it.
  it('is stopped by asking the server', () => {
    const store = useOperationTasksStore();
    heldWindow();
    store.adoptOperation(running());

    store.cancelOperation(store.operations[0].id);

    expect(cancelOperationTask).toHaveBeenCalledWith('task-1');
    expect(store.operations[0]).toMatchObject({ cancelling: true });
  });

  it('tells whoever is listening when it ends, and where it landed', async () => {
    const store = useOperationTasksStore();
    const open = heldWindow();
    const reports = [];
    store.whenAdoptedSettles((report) => reports.push(report));

    store.adoptOperation(running());
    open.finish({ type: 'done', destination: 'Archive/2026 (2)' });
    await settled();

    expect(reports).toEqual([
      {
        taskId: 'task-1',
        kind: 'copy',
        destination: 'Archive/2026',
        result: { type: 'done', destination: 'Archive/2026 (2)' },
      },
    ]);
  });

  it('tells them when it ended badly too, and takes the bar away', async () => {
    const store = useOperationTasksStore();
    const open = heldWindow();
    const reports = [];
    store.whenAdoptedSettles((report) => reports.push(report));

    store.adoptOperation(running());
    open.fail(new Error('no room left'));
    await settled();

    expect(reports.at(0)?.error?.message).toBe('no room left');
    expect(store.operations).toHaveLength(0);
  });
});

describe('asking what is running', () => {
  it('adopts the running ones and leaves the rest alone', async () => {
    const store = useOperationTasksStore();
    heldWindow();
    fetchOperationTasks.mockResolvedValue({
      items: [
        running({ id: 'task-1' }),
        running({ id: 'task-2', state: 'done' }),
        running({ id: 'task-3', state: 'cancelled' }),
      ],
      interrupted: [],
    });

    const { adopted } = await store.adoptServerOperations();

    expect(adopted).toHaveLength(1);
    expect(store.operations.map((operation) => operation.taskId)).toEqual(['task-1']);
  });

  /**
   * And hands back what a restart took without adopting it: nothing is resumed
   * across a stop, so there is nothing to follow — only somebody to tell.
   */
  it('hands back what a restart interrupted, with its paths', async () => {
    const store = useOperationTasksStore();
    fetchOperationTasks.mockResolvedValue({
      items: [],
      interrupted: [{ id: 'lost-1', kind: 'move', destination: 'Archive', paths: ['Docs/a.txt'] }],
    });

    const { adopted, interrupted } = await store.adoptServerOperations();

    expect(adopted).toEqual([]);
    expect(interrupted).toEqual([
      { id: 'lost-1', kind: 'move', destination: 'Archive', paths: ['Docs/a.txt'] },
    ]);
    expect(store.operations).toHaveLength(0);
    expect(watchOperationTask).not.toHaveBeenCalled();
  });
});
