import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cutting a large selection into requests a server will accept.
 *
 * The whole selection in one body came back as "request entity too large"
 * before anything read it, so copy, move and delete are sent in parts.
 *
 * What the parts are differs, and that is the point of this file. A deletion is
 * several operations: each request is one, each counts from zero, and the bar is
 * added up here — batches cannot be offset into a global counter, so each
 * advances the total by its own delta, or the bar goes backwards or stops at a
 * third on exactly the operations long enough for anyone to watch. A transfer is
 * one operation however many requests describe it: the server registers it, the
 * parts all name it, and the counting is its. A reader who closes the tab half a
 * second in used to lose every part that had not been sent yet.
 *
 * And a failure must stop what is queued behind it. `Promise.all` rejects on the
 * first failure without cancelling the rest, so a cancelled delete would
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
/** The parts of a transfer that are added to an operation already open. */
const partsAdded = () =>
  requestJson.mock.calls
    .filter(([, opts]) => opts?.body)
    .map(([, opts]) => JSON.parse(opts.body))
    .filter((body) => body.taskId);
const transferBodies = () => [...bodiesSent(), ...partsAdded()];

/**
 * A server that registers the transfer and names it.
 *
 * Nothing else can be sent until it has: the parts of one selection are added to
 * an operation by its id, so a stream that never says `start` is a transfer with
 * no second part.
 */
const namesTheOperation = (taskId = 'task-1', answer = { items: [], destination: 'Archive' }) => {
  requestStream.mockImplementation((_url, { onEvent }) => {
    onEvent?.({ type: 'start', taskId, totalItems: 1, totalBytes: 0 });
    return Promise.resolve(answer);
  });
  requestJson.mockResolvedValue({ taskId, accepted: 1 });
};

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
    // Nothing more is coming, so the server may finish the operation on this.
    expect(bodiesSent()[0].continues).toBeUndefined();
    expect(bodiesSent()[0].taskId).toBeUndefined();
  });

  it('sends exactly one request at the batch size, not two', async () => {
    await copyItems(items(500), 'Archive');

    expect(requestStream).toHaveBeenCalledTimes(1);
  });

  /**
   * One operation, in two requests: the first opens it, carries the stream and
   * says that more is coming; the second is added to it by id and answered at
   * once, because one window onto an operation is enough.
   */
  it('describes one item past the batch size in two requests, as one operation', async () => {
    namesTheOperation('task-7');

    await copyItems(items(501), 'Archive');

    expect(requestStream).toHaveBeenCalledTimes(1);
    expect(bodiesSent()[0]).toMatchObject({ continues: true });
    expect(bodiesSent()[0].items).toHaveLength(500);
    expect(partsAdded()).toHaveLength(1);
    expect(partsAdded()[0]).toMatchObject({ taskId: 'task-7' });
    // The last part says nothing about more coming, which is how the operation
    // knows it may finish on what it has.
    expect(partsAdded()[0].continues).toBeUndefined();
    expect(partsAdded()[0].items).toHaveLength(1);
  });

  it('says which part is the last one, and not before', async () => {
    namesTheOperation();

    await copyItems(items(1501), 'Archive');

    expect(bodiesSent()[0].continues).toBe(true);
    expect(partsAdded().map((body) => Boolean(body.continues))).toEqual([true, true, false]);
  });

  it('loses nothing and duplicates nothing across the parts', async () => {
    namesTheOperation();
    const all = items(1250);

    await copyItems(all, 'Archive');

    const sent = transferBodies().flatMap((b) => b.items);
    expect(sent).toHaveLength(1250);
    expect(new Set(sent).size).toBe(1250);
    expect(sent.sort()).toEqual([...all].sort());
  });

  it('carries the destination on every part', async () => {
    namesTheOperation();

    await copyItems(items(1200), 'Archive/2026');

    expect(transferBodies().every((b) => b.destination === 'Archive/2026')).toBe(true);
  });

  /**
   * And nothing is sent that has nowhere to go: the parts are added to an
   * operation by its id, so a first request that never named one is the end of
   * it rather than a selection sent into the void.
   */
  it('adds no part to an operation the server never named', async () => {
    requestStream.mockResolvedValue({ items: [], destination: 'Archive' });

    await copyItems(items(1200), 'Archive');

    expect(partsAdded()).toEqual([]);
  });

  it('names the operation to its caller, so it can be stopped', async () => {
    namesTheOperation('task-42');
    const named = [];

    await copyItems(items(3), 'Archive', { onTask: (id) => named.push(id) });

    expect(named).toEqual(['task-42']);
  });

  /**
   * A deletion is cut up the same way, and for the same reason — and it is one
   * operation too. It used to be one operation per request, each counting from
   * zero, with the bar added up here; the counting is the server's now.
   */
  it('describes a large deletion in parts of one operation', async () => {
    namesTheOperation('task-3');

    await deleteItemsStream(items(1100));

    expect(requestStream).toHaveBeenCalledTimes(1);
    expect(requestStream.mock.calls[0][0]).toBe('/api/files/delete-stream');
    expect(bodiesSent()[0]).toMatchObject({ continues: true });
    expect(partsAdded().map((body) => Boolean(body.continues))).toEqual([true, false]);
    expect(transferBodies().flatMap((body) => body.items)).toHaveLength(1100);
  });
});

describe('when a part fails', () => {
  /**
   * What is queued behind a failure is dropped by the operation itself now, and
   * a part that arrives afterwards is refused: one place, on the server, where
   * it used to be a loop here that stopped sending. What is left here is that a
   * refusal reaches the caller rather than being swallowed.
   */
  it('reports the failure rather than resolving with partial results', async () => {
    requestStream.mockRejectedValue(new Error('server said no'));

    await expect(deleteItemsStream(items(1200))).rejects.toThrow('server said no');
  });

  /**
   * A transfer has two things in flight at once — the window onto the operation
   * and the parts still being added to it — and either can fail. Both are waited
   * for before either is thrown: throwing the refusal and walking away would
   * leave the window's own failure unhandled, which is a warning in the console
   * of anybody whose copy was refused.
   */
  it('reports a refused part of a transfer', async () => {
    namesTheOperation();
    requestJson.mockRejectedValue(new Error('no room left'));

    await expect(copyItems(items(600), 'Archive')).rejects.toThrow('no room left');
  });

  it('reports a refused transfer, however many parts it had', async () => {
    requestStream.mockRejectedValue(new Error('not allowed there'));

    await expect(copyItems(items(600), 'Archive')).rejects.toThrow('not allowed there');
  });
});

describe('the answer a transfer gives', () => {
  /**
   * One answer for the whole gesture, whatever it took to describe it: the
   * operation collects what each of its parts did, so the caller is told once
   * where everything landed. It used to be folded together here, out of one
   * answer per request.
   */
  it('is the operation\u2019s own, covering every part of the selection', async () => {
    namesTheOperation('task-1', {
      items: ['a', 'b', 'c'],
      destination: 'Archive (2)',
      unreadable: 2,
    });

    const result = await copyItems(items(600), 'Archive');

    expect(result.items).toEqual(['a', 'b', 'c']);
    // The server may rename to dodge a collision; the caller needs where it landed.
    expect(result.destination).toBe('Archive (2)');
    expect(result.unreadable).toBe(2);
  });

  it('is the same shape for a selection that fitted in one request', async () => {
    requestStream.mockResolvedValue({ items: ['a'], destination: 'Archive' });

    const result = await copyItems(items(3), 'Archive');

    expect(result).toMatchObject({ items: ['a'], destination: 'Archive', unreadable: 0 });
  });
});

describe('the answer a deletion gives', () => {
  // One answer for the whole gesture, whatever it took to describe it: the
  // operation collects what each of its parts did.
  it('is the operation\u2019s own, covering every part of the selection', async () => {
    namesTheOperation('task-1', { items: ['a', 'b', 'c'] });

    const result = await deleteItemsStream(items(1200));

    expect(result).toEqual({ success: true, items: ['a', 'b', 'c'] });
  });

  it('is an empty list rather than nothing when the operation says nothing', async () => {
    requestStream.mockResolvedValue({});

    expect(await deleteItemsStream(items(2))).toEqual({ success: true, items: [] });
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

    expect(await getDeleteImpact(items(5))).toEqual({ shareCount: 0, shares: [], trash: null });
  });

  it('survives a response that carries no shares field', async () => {
    requestJson.mockResolvedValue({});

    expect(await getDeleteImpact(items(5))).toEqual({ shareCount: 0, shares: [], trash: null });
  });
});

/**
 * One gesture, one count of what it could not read.
 *
 * A selection the client chose to split is still one copy to the person who
 * asked for it, and a copy short of files reported as finished is the failure
 * this guards. The count is now the operation's, added up across its parts
 * where the parts are — on the server — rather than folded together here.
 */
describe('the entries a transfer could not read', () => {
  it('is the count the operation gives, for the whole selection', async () => {
    namesTheOperation('task-1', { items: [], unreadable: 6 });

    const result = await copyItems(items(1001), 'Archive');

    expect(result.unreadable).toBe(6);
  });

  it('is zero when everything was read', async () => {
    namesTheOperation();

    const result = await copyItems(items(501), 'Archive');

    expect(result.unreadable).toBe(0);
  });
});
