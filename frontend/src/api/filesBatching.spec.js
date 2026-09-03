import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cutting a large selection into requests a server will accept.
 *
 * The whole selection in one body came back as "request entity too large"
 * before anything read it, so copy, move and delete are sent in batches. What
 * makes this worth testing is not the slicing — it is the progress accounting
 * on top of it. Batches run concurrently, so per-batch counters cannot be
 * offset into a global one; each batch advances the total by its own delta.
 * Get that wrong and the bar goes backwards, or stops at a third, on exactly
 * the operations long enough for anyone to watch.
 *
 * And a failure must stop the batches queued behind it. `Promise.all` rejects
 * on the first failure without cancelling the rest, so a cancelled delete would
 * otherwise keep deleting.
 */

const requestStream = vi.fn();
const requestJson = vi.fn();

vi.mock('./http', () => ({
  requestStream: (...args) => requestStream(...args),
  requestJson: (...args) => requestJson(...args),
  requestRaw: vi.fn(),
  normalizePath: (p) => String(p || '').replace(/^\/+|\/+$/g, ''),
  encodePath: (p) => String(p || ''),
  buildUrl: (p) => `https://files.example.com${p}`,
}));

import { copyItems, deleteItemsStream, getDeleteImpact } from './files.api';

const items = (count, prefix = 'Docs/file') =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}.txt`);

const bodiesSent = () => requestStream.mock.calls.map(([, opts]) => JSON.parse(opts.body));

beforeEach(() => {
  requestStream.mockReset();
  requestJson.mockReset();
  requestStream.mockResolvedValue({ items: [] });
});

describe('how a selection is cut up', () => {
  it('sends a small selection as one request', async () => {
    await copyItems(items(10), 'Archive');

    expect(requestStream).toHaveBeenCalledTimes(1);
    expect(bodiesSent()[0].items).toHaveLength(10);
  });

  it('sends exactly one request at the batch size, not two', async () => {
    await copyItems(items(500), 'Archive');

    expect(requestStream).toHaveBeenCalledTimes(1);
  });

  it('splits one item past the batch size into two', async () => {
    await copyItems(items(501), 'Archive');

    expect(requestStream).toHaveBeenCalledTimes(2);
    expect(bodiesSent().map((b) => b.items.length)).toEqual([500, 1]);
  });

  it('loses nothing and duplicates nothing across the batches', async () => {
    const all = items(1250);

    await copyItems(all, 'Archive');

    const sent = bodiesSent().flatMap((b) => b.items);
    expect(sent).toHaveLength(1250);
    expect(new Set(sent).size).toBe(1250);
    expect(sent.sort()).toEqual([...all].sort());
  });

  it('carries the destination on every batch', async () => {
    await copyItems(items(1200), 'Archive/2026');

    expect(bodiesSent().every((b) => b.destination === 'Archive/2026')).toBe(true);
  });

  it('deletes in batches of 500 too', async () => {
    await deleteItemsStream(items(1100));

    expect(requestStream).toHaveBeenCalledTimes(3);
    expect(requestStream.mock.calls[0][0]).toBe('/api/files/delete-stream');
  });
});

describe('progress accounting across batches', () => {
  /**
   * Batches run one after another here (copy and move pass no concurrency), so
   * the harness hands back a controller per batch as it opens: emit into it,
   * then finish it to let the next one start.
   */
  const batchRunner = () => {
    const opened = [];
    requestStream.mockImplementation(
      (_url, { onEvent }) =>
        new Promise((resolve) => {
          opened.push({ emit: onEvent, finish: () => resolve({ items: [] }) });
        })
    );
    return {
      opened,
      /** Wait until batch `index` has opened. */
      async waitFor(index) {
        for (let tries = 0; tries < 50 && opened.length <= index; tries += 1) {
          await Promise.resolve();
        }
        return opened[index];
      },
    };
  };

  it('reports the whole selection, not one batch, at the start', async () => {
    const seen = [];
    const runner = batchRunner();
    const run = copyItems(items(800), 'Archive', { onEvent: (e) => seen.push(e) });

    const first = await runner.waitFor(0);
    first.emit({ type: 'start', totalItems: 500, totalBytes: 1000 });
    first.finish();
    (await runner.waitFor(1)).finish();
    await run;

    expect(seen[0]).toMatchObject({ type: 'start', totalItems: 800 });
  });

  it('emits one start for the run, however many batches open', async () => {
    const seen = [];
    const runner = batchRunner();
    const run = copyItems(items(800), 'Archive', { onEvent: (e) => seen.push(e) });

    const first = await runner.waitFor(0);
    first.emit({ type: 'start', totalItems: 500, totalBytes: 1000 });
    first.finish();
    const second = await runner.waitFor(1);
    second.emit({ type: 'start', totalItems: 300, totalBytes: 500 });
    second.finish();
    await run;

    expect(seen.filter((e) => e.type === 'start')).toHaveLength(1);
  });

  /**
   * The bug this shape exists to prevent: each batch counts from zero, so
   * adding the raw numbers makes the total lurch, and taking the last one makes
   * it fall back to where the new batch started.
   */
  it('never goes backwards when the next batch restarts its own count', async () => {
    const seen = [];
    const runner = batchRunner();
    const run = copyItems(items(1000), 'Archive', { onEvent: (e) => seen.push(e) });

    const first = await runner.waitFor(0);
    first.emit({ type: 'progress', completedItems: 250 });
    first.emit({ type: 'progress', completedItems: 500 });
    first.finish();
    const second = await runner.waitFor(1);
    second.emit({ type: 'progress', completedItems: 100 });
    second.emit({ type: 'progress', completedItems: 500 });
    second.finish();
    await run;

    const counts = seen.filter((e) => e.type === 'progress').map((e) => e.completedItems);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts.at(-1)).toBe(1000);
  });

  it('turns the running total into a percentage of the whole selection', async () => {
    const seen = [];
    const runner = batchRunner();
    const run = copyItems(items(1000), 'Archive', { onEvent: (e) => seen.push(e) });

    const first = await runner.waitFor(0);
    first.emit({ type: 'progress', completedItems: 500 });
    first.finish();
    (await runner.waitFor(1)).finish();
    await run;

    const last = seen.filter((e) => e.type === 'progress').pop();
    expect(last.percent).toBe(50);
  });

  it('passes an event it does not understand through untouched', async () => {
    const seen = [];
    const runner = batchRunner();
    const run = copyItems(items(800), 'Archive', { onEvent: (e) => seen.push(e) });

    const first = await runner.waitFor(0);
    first.emit({ type: 'skipped', name: 'locked.txt' });
    first.finish();
    (await runner.waitFor(1)).finish();
    await run;

    expect(seen).toContainEqual({ type: 'skipped', name: 'locked.txt' });
  });

  it('says nothing to a caller that asked for no events', async () => {
    const runner = batchRunner();
    const run = copyItems(items(800), 'Archive');

    const first = await runner.waitFor(0);
    expect(() => first.emit({ type: 'progress', completedItems: 10 })).not.toThrow();
    first.finish();
    (await runner.waitFor(1)).finish();

    await expect(run).resolves.toBeTruthy();
  });
});

describe('when a batch fails', () => {
  /**
   * The batches run one after another, deliberately — the server resolves name
   * collisions with a check-then-use that is only safe while a transfer walks
   * its items in order. So a failure stops the run where it stands, and the
   * batches behind it are never sent.
   */
  it('stops at the first failure rather than working through the rest', async () => {
    const total = 5000; // ten batches
    requestStream.mockImplementation(async () => {
      throw new Error('cancelled');
    });

    await expect(copyItems(items(total), 'Archive')).rejects.toThrow('cancelled');

    // Only the batches already in flight may have gone out — never all ten.
    expect(requestStream.mock.calls.length).toBeLessThan(10);
  });

  it('reports the failure rather than resolving with partial results', async () => {
    requestStream.mockRejectedValue(new Error('server said no'));

    await expect(deleteItemsStream(items(1200))).rejects.toThrow('server said no');
  });
});

describe('folding the batch answers back together', () => {
  it('concatenates the transferred items', async () => {
    requestStream
      .mockResolvedValueOnce({ items: ['a', 'b'], destination: 'Archive' })
      .mockResolvedValueOnce({ items: ['c'], destination: 'Archive (2)' });

    const result = await copyItems(items(600), 'Archive');

    expect(result.items).toEqual(['a', 'b', 'c']);
  });

  /** The server may rename to dodge a collision; the caller needs where it landed. */
  it('keeps the destination the server settled on', async () => {
    requestStream
      .mockResolvedValueOnce({ items: [], destination: 'Archive' })
      .mockResolvedValueOnce({ items: [], destination: 'Archive (2)' });

    const result = await copyItems(items(600), 'Archive');

    expect(result.destination).toBe('Archive (2)');
  });

  it('returns the single response untouched when there was no batching', async () => {
    requestStream.mockResolvedValue({ items: ['a'], destination: 'Archive' });

    const result = await copyItems(items(3), 'Archive');

    expect(result).toMatchObject({ items: ['a'], destination: 'Archive' });
  });

  it('flattens the deleted items from every batch', async () => {
    requestStream
      .mockResolvedValueOnce({ items: ['a'] })
      .mockResolvedValueOnce({ items: ['b', 'c'] })
      .mockResolvedValueOnce({ items: [] });

    const result = await deleteItemsStream(items(1200));

    expect(result).toEqual({ success: true, items: ['a', 'b', 'c'] });
  });
});

describe('what a deletion is about to break', () => {
  /**
   * A folder and a file inside it can report the same share. Counting it twice
   * tells somebody two links will break when only one will.
   */
  it('counts a share reported by two batches once', async () => {
    const share = { id: 'sh_1', label: 'Photos' };
    requestJson
      .mockResolvedValueOnce({ shares: [share] })
      .mockResolvedValueOnce({ shares: [share, { id: 'sh_2', label: 'Docs' }] })
      .mockResolvedValueOnce({ shares: [] });

    const impact = await getDeleteImpact(items(1200));

    expect(impact.shareCount).toBe(2);
    expect(impact.shares.map((s) => s.id).sort()).toEqual(['sh_1', 'sh_2']);
  });

  it('answers zero when nothing is shared', async () => {
    requestJson.mockResolvedValue({ shares: [] });

    expect(await getDeleteImpact(items(5))).toEqual({ shareCount: 0, shares: [] });
  });

  it('survives a response that carries no shares field', async () => {
    requestJson.mockResolvedValue({});

    expect(await getDeleteImpact(items(5))).toEqual({ shareCount: 0, shares: [] });
  });
});
