import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Deleting a large selection used to send every path in one request, which a
 * server rejects outright as too large. The batching that already existed for
 * the non-streaming delete was never applied to this path — the one the UI
 * actually uses, because it is the one with a progress bar.
 *
 * Batching is only worth anything if the progress bar and the cancel button
 * survive it, so that is what these pin.
 */

// vi.hoisted, because vi.mock is lifted above this file's own declarations:
// a plain const would not be initialised when the factory runs.
const { requestStream, requestJson } = vi.hoisted(() => ({
  requestStream: vi.fn(async () => ({ success: true, items: [] })),
  requestJson: vi.fn(async () => ({})),
}));

vi.mock('./http', () => ({
  requestStream,
  requestJson,
  requestRaw: vi.fn(),
  normalizePath: (p) => p,
  encodePath: (p) => p,
  buildUrl: (p) => p,
}));

const { deleteItemsStream, copyItems, moveItems } = await import('./files.api');

const selection = (count) =>
  Array.from({ length: count }, (_, i) => ({ path: 'Photos/2024', name: `IMG_${i}.jpeg` }));

/**
 * Replays what the server sends for the operation the first request opens.
 *
 * It counts for the whole selection, not for the request: the parts that follow
 * are added to the same operation, and only this one carries the stream.
 */
const respondWithProgress = (total = 0) =>
  requestStream.mockImplementation(async (_endpoint, { body, onEvent }) => {
    const items = JSON.parse(body).items;
    const totalItems = total || items.length;
    onEvent?.({ type: 'start', taskId: 'task-1', phase: 'preparing', totalItems });
    onEvent?.({
      type: 'progress',
      completedItems: totalItems,
      percent: 100,
      currentName: items.at(-1)?.name,
    });
    return { success: true, items: Array.from({ length: totalItems }, (_, i) => `IMG_${i}.jpeg`) };
  });

// Counters are reset between tests, and the implementation is reinstalled with
// them: clearing a mock also drops what it was told to do.
beforeEach(() => {
  requestStream.mockReset();
  requestJson.mockReset();
  requestJson.mockResolvedValue({ taskId: 'task-1', accepted: 1 });
  respondWithProgress();
});

describe('Streamed deletion', () => {
  it('sends a small selection as one request', async () => {
    await deleteItemsStream(selection(120));

    expect(requestStream).toHaveBeenCalledTimes(1);
  });

  /**
   * The body ceiling is the whole reason a selection is cut up, and it still
   * holds of every request — only the first of them carries the stream, because
   * the rest are added to the operation it opened.
   */
  it('keeps every request of a large selection under the ceiling', async () => {
    await deleteItemsStream(selection(2000));

    const sent = [...requestStream.mock.calls, ...requestJson.mock.calls];
    expect(sent).toHaveLength(4);
    const sizes = sent.map(([, opts]) => JSON.parse(opts.body).items.length);
    expect(sizes).toEqual([500, 500, 500, 500]);
    sent.forEach(([, opts]) => {
      expect(opts.body.length).toBeLessThan(100 * 1024);
    });
  });

  // One operation, one count — the server's, for the whole selection. The
  // caller used to add up per-request counters that each started at zero, and a
  // bar that went backwards at every boundary is what that cost.
  it('reports the operation\u2019s own count of the whole selection', async () => {
    const events = [];
    // The operation counts for the selection, not for the request that opened
    // it: the other 1500 paths are added to the same one.
    respondWithProgress(2000);

    await deleteItemsStream(selection(2000), { onEvent: (event) => events.push(event) });

    const starts = events.filter((event) => event.type === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].totalItems).toBe(2000);
    expect(events.filter((event) => event.type === 'progress').at(-1)).toMatchObject({
      completedItems: 2000,
      percent: 100,
    });
  });

  it('returns every deleted item, from the one answer', async () => {
    respondWithProgress(1200);

    const result = await deleteItemsStream(selection(1200));

    expect(result.success).toBe(true);
    expect(result.items).toHaveLength(1200);
  });

  /**
   * What is queued behind a failure is the operation's to drop, and a part that
   * arrives afterwards is refused: there is no loop here any more that could
   * keep sending. What is left to hold here is that the refusal reaches the
   * caller rather than being swallowed into a partial success.
   */
  it('reports a stopped deletion rather than resolving with what it managed', async () => {
    requestStream.mockImplementation(async (_endpoint, { onEvent }) => {
      onEvent?.({ type: 'start', taskId: 'task-1', totalItems: 2000 });
      throw Object.assign(new Error('Cancelled.'), { code: 'OPERATION_CANCELLED' });
    });

    await expect(deleteItemsStream(selection(2000))).rejects.toThrow(/cancelled/i);
    // It does not carry on through the whole selection after the user asked it
    // to stop. Batches already in flight when the failure lands still count,
    // so the guarantee is "stops", not an exact number.
    expect(requestStream.mock.calls.length).toBeLessThan(6);
    const before = requestStream.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    // And nothing keeps going once the error has propagated.
    expect(requestStream.mock.calls.length).toBe(before);
  });

  it('passes the abort signal to every batch', async () => {
    const controller = new AbortController();

    await deleteItemsStream(selection(1200), { signal: controller.signal });

    requestStream.mock.calls.forEach(([, opts]) => {
      expect(opts.signal).toBe(controller.signal);
    });
  });
});

/**
 * Copy and move send the same shape as delete and had the same ceiling, which is
 * the whole reason a selection is cut up at all: one body holding every path is
 * refused before anything reads it.
 *
 * What they are not is several operations. A transfer is registered in the
 * server and the parts of one selection are added to it by id, so the counting
 * and the answer are its — which is what lets a copy outlive the tab that asked
 * for it. The accounting a deletion still needs is above; the shape of a
 * transfer's parts is in `filesBatching.spec.js`.
 */
describe('Streamed transfers', () => {
  const namesTheOperation = () => {
    requestStream.mockImplementation(async (_endpoint, { body, onEvent }) => {
      const { items } = JSON.parse(body);
      onEvent?.({
        type: 'start',
        taskId: 'task-1',
        totalBytes: items.length * 1000,
        totalItems: items.length,
        destination: 'Target',
      });
      return {
        success: true,
        destination: 'Target',
        items: items.map((item) => ({ from: item.name, to: `Target/${item.name}` })),
      };
    });
    requestJson.mockResolvedValue({ taskId: 'task-1', accepted: 1 });
  };

  beforeEach(() => {
    requestStream.mockReset();
    requestJson.mockReset();
    namesTheOperation();
  });

  it.each([
    ['copy', (...args) => copyItems(...args)],
    ['move', (...args) => moveItems(...args)],
  ])('keeps every request of a large %s under the ceiling', async (_label, transfer) => {
    await transfer(selection(2000), 'Target');

    const sent = [...requestStream.mock.calls, ...requestJson.mock.calls];
    expect(sent).toHaveLength(4);
    sent.forEach(([, opts]) => {
      const payload = JSON.parse(opts.body);
      expect(payload.items.length).toBe(500);
      // The destination travels with every part, not just the first.
      expect(payload.destination).toBe('Target');
      expect(opts.body.length).toBeLessThan(100 * 1024);
    });
  });

  it('reports what the operation says, and asks for no accounting of its own', async () => {
    const events = [];

    await copyItems(selection(2000), 'Target', { onEvent: (event) => events.push(event) });

    expect(events.filter((event) => event.type === 'start')).toHaveLength(1);
    expect(events[0]).toMatchObject({ taskId: 'task-1', destination: 'Target' });
  });

  it('returns every transferred entry and the final destination', async () => {
    const result = await moveItems(selection(1200), 'Target');

    expect(result.items).toHaveLength(500);
    expect(result.destination).toBe('Target');
  });

  it('sends a small transfer as a single request', async () => {
    await copyItems(selection(50), 'Target');

    expect(requestStream).toHaveBeenCalledTimes(1);
    expect(requestJson).not.toHaveBeenCalled();
  });
});
