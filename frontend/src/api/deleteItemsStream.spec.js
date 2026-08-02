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

const { deleteItemsStream, copyItems, moveItems } = await import('./files.api');

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
 * Copy and move send the same shape as delete and had the same ceiling. Their
 * progress bar is driven by bytes, and a batch only learns its own total when
 * the server prepares it — so the percentage comes from item counts, which are
 * known upfront and cannot make the bar jump backwards.
 */
describe('Streamed transfers', () => {
  const respondWithBytes = () =>
    requestStream.mockImplementation(async (_endpoint, { body, onEvent }) => {
      const { items } = JSON.parse(body);
      const totalBytes = items.length * 1000;
      onEvent?.({ type: 'start', totalBytes, totalItems: items.length, destination: 'Target' });
      items.forEach((item, index) => {
        onEvent?.({
          type: 'progress',
          completedItems: index + 1,
          copiedBytes: (index + 1) * 1000,
          totalBytes,
        });
      });
      return {
        success: true,
        destination: 'Target',
        items: items.map((i) => ({ from: i.name, to: `Target/${i.name}` })),
      };
    });

  beforeEach(() => {
    requestStream.mockReset();
    respondWithBytes();
  });

  it.each([
    ['copy', (...args) => copyItems(...args)],
    ['move', (...args) => moveItems(...args)],
  ])('splits a large %s into bounded requests', async (_label, transfer) => {
    await transfer(selection(2000), 'Target');

    expect(requestStream).toHaveBeenCalledTimes(4);
    requestStream.mock.calls.forEach(([, opts]) => {
      const payload = JSON.parse(opts.body);
      expect(payload.items.length).toBe(500);
      // The destination travels with every batch, not just the first.
      expect(payload.destination).toBe('Target');
      expect(opts.body.length).toBeLessThan(100 * 1024);
    });
  });

  it('keeps one progress bar across the batches', async () => {
    const events = [];

    await copyItems(selection(2000), 'Target', { onEvent: (e) => events.push(e) });

    expect(events.filter((e) => e.type === 'start')).toHaveLength(1);

    const progress = events.filter((e) => e.type === 'progress');
    const percents = progress.map((e) => e.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents.at(-1)).toBe(100);

    // Bytes accumulate across batches instead of restarting at each one.
    const copied = progress.map((e) => e.copiedBytes);
    expect(copied).toEqual([...copied].sort((a, b) => a - b));
    expect(copied.at(-1)).toBe(2000 * 1000);
  });

  it('returns every transferred entry and the final destination', async () => {
    const result = await moveItems(selection(1200), 'Target');

    expect(result.items).toHaveLength(1200);
    expect(result.destination).toBe('Target');
  });

  it('sends a small transfer as a single request', async () => {
    await copyItems(selection(50), 'Target');

    expect(requestStream).toHaveBeenCalledTimes(1);
  });
});
