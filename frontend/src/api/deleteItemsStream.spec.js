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
const { requestStream } = vi.hoisted(() => ({
  requestStream: vi.fn(async () => ({ success: true, items: [] })),
}));

vi.mock('./http', () => ({
  requestStream,
  requestJson: vi.fn(),
  requestRaw: vi.fn(),
  normalizePath: (p) => p,
  encodePath: (p) => p,
  buildUrl: (p) => p,
}));

const { deleteItemsStream } = await import('./files.api');

const selection = (count) =>
  Array.from({ length: count }, (_, i) => ({ path: 'Photos/2024', name: `IMG_${i}.jpeg` }));

/** Replays what the server sends for one batch. */
const respondWithProgress = () =>
  requestStream.mockImplementation(async (_endpoint, { body, onEvent }) => {
    const items = JSON.parse(body).items;
    onEvent?.({ type: 'start', phase: 'preparing', totalItems: items.length });
    items.forEach((item, index) => {
      onEvent?.({
        type: 'progress',
        completedItems: index + 1,
        percent: Math.round(((index + 1) / items.length) * 100),
        currentName: item.name,
      });
    });
    return { success: true, items: items.map((i) => i.name) };
  });



// Counters are reset between tests, and the implementation is reinstalled with
// them: clearing a mock also drops what it was told to do.
beforeEach(() => {
  requestStream.mockReset();
  respondWithProgress();
});

describe('Streamed deletion', () => {
  it('sends a small selection as one request', async () => {

    await deleteItemsStream(selection(120));

    expect(requestStream).toHaveBeenCalledTimes(1);
  });

  it('splits a large selection into bounded requests', async () => {
    await deleteItemsStream(selection(2000));

    expect(requestStream).toHaveBeenCalledTimes(4);
    const sizes = requestStream.mock.calls.map(([, opts]) => JSON.parse(opts.body).items.length);
    expect(sizes).toEqual([500, 500, 500, 500]);
    // Each request stays far below any reasonable body limit.
    requestStream.mock.calls.forEach(([, opts]) => {
      expect(opts.body.length).toBeLessThan(100 * 1024);
    });
  });

  it('reports one continuous progress over the whole selection', async () => {
    const events = [];

    await deleteItemsStream(selection(2000), { onEvent: (e) => events.push(e) });

    const starts = events.filter((e) => e.type === 'start');
    expect(starts).toHaveLength(1);
    // The bar is driven by the caller: it must see the real total, not 500.
    expect(starts[0].totalItems).toBe(2000);

    const progress = events.filter((e) => e.type === 'progress');
    const counts = progress.map((e) => e.completedItems);
    expect(counts[0]).toBe(1);
    expect(counts.at(-1)).toBe(2000);
    // Never goes backwards at a batch boundary, which is what a naive
    // pass-through of per-batch counters would do.
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(progress.at(-1).percent).toBe(100);
  });

  it('returns every deleted item across batches', async () => {
    const result = await deleteItemsStream(selection(1200));

    expect(result.success).toBe(true);
    expect(result.items).toHaveLength(1200);
  });

  it('stops at the batch that was cancelled', async () => {
    let calls = 0;
    requestStream.mockImplementation(async (_endpoint, { body, onEvent }) => {
      calls += 1;
      if (calls === 3) {
        const abort = new Error('The operation was aborted.');
        abort.name = 'AbortError';
        throw abort;
      }
      const items = JSON.parse(body).items;
      onEvent?.({ type: 'start', totalItems: items.length });
      return { success: true, items: items.map((i) => i.name) };
    });

    await expect(deleteItemsStream(selection(2000))).rejects.toThrow(/aborted/i);
    // It does not carry on deleting after the user asked it to stop.
    expect(requestStream).toHaveBeenCalledTimes(3);
  });

  it('passes the abort signal to every batch', async () => {
    const controller = new AbortController();

    await deleteItemsStream(selection(1200), { signal: controller.signal });

    requestStream.mock.calls.forEach(([, opts]) => {
      expect(opts.signal).toBe(controller.signal);
    });
  });
});
