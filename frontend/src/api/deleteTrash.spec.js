import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The delete requests and the trash. A permanent deletion is only ever asked
 * for explicitly — a request without the flag means what it always meant, and
 * the server decides — and the per-item answer about the trash survives the
 * batching large selections go through.
 */

const { requestJson, requestStream } = vi.hoisted(() => ({
  requestJson: vi.fn(),
  requestStream: vi.fn(async () => ({ success: true, items: [] })),
}));

vi.mock('./http', () => ({
  requestJson,
  requestStream,
  requestRaw: vi.fn(),
  normalizePath: (p) => p,
  encodePath: (p) => p,
  buildUrl: (p) => p,
}));

const { deleteItems, deleteItemsStream, getDeleteImpact } = await import('./files.api');

const bodies = (mock) => mock.mock.calls.map(([, options]) => JSON.parse(options.body));
const selection = (count) =>
  Array.from({ length: count }, (_, i) => ({ path: 'Photos', name: `IMG_${i}.jpeg` }));

beforeEach(() => {
  requestJson.mockReset();
  requestStream.mockReset();
  requestStream.mockResolvedValue({ success: true, items: [] });
});

describe('asking for a permanent deletion', () => {
  it('is sent with the streamed deletion when asked for', async () => {
    await deleteItemsStream(selection(2), { permanent: true });

    expect(bodies(requestStream)[0]).toMatchObject({ permanent: true });
  });

  it('is not sent at all otherwise', async () => {
    await deleteItemsStream(selection(2));

    expect(bodies(requestStream)[0]).not.toHaveProperty('permanent');
  });

  /**
   * A large selection is one operation described in several requests now, so
   * only the first carries the stream: the rest are added to it by id. Each of
   * them still has to say what kind of deletion this is — a part that forgot
   * would put in the trash what the reader asked to be gone for good.
   */
  it('is sent with every part of a large selection', async () => {
    requestJson.mockResolvedValue({ taskId: 'task-1', accepted: 1 });
    requestStream.mockImplementation(async (_endpoint, { onEvent }) => {
      onEvent?.({ type: 'start', taskId: 'task-1' });
      return { items: [] };
    });

    await deleteItemsStream(selection(5000), { permanent: true });

    const parts = [...requestStream.mock.calls, ...requestJson.mock.calls];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map(([, options]) => JSON.parse(options.body)).every((b) => b.permanent)).toBe(
      true
    );
  });

  it('is sent with the plain deletion too', async () => {
    requestJson.mockResolvedValue({ success: true, items: [] });

    await deleteItems(selection(1), { permanent: true });
    await deleteItems(selection(1));

    const [first, second] = bodies(requestJson);
    expect(first).toMatchObject({ permanent: true });
    expect(second).not.toHaveProperty('permanent');
  });
});

describe('what the trash will do, across batches', () => {
  it('keeps every item’s answer when the selection is sent in several requests', async () => {
    requestJson.mockImplementation(async (_endpoint, { body }) => {
      const { items } = JSON.parse(body);
      return {
        shares: [],
        trash: {
          enabled: true,
          retentionDays: 30,
          items: items.map((item) => ({
            path: `${item.path}/${item.name}`,
            disposition: 'trash',
            reason: null,
          })),
        },
      };
    });

    const impact = await getDeleteImpact(selection(5000));

    expect(requestJson.mock.calls.length).toBeGreaterThan(1);
    expect(impact.trash.enabled).toBe(true);
    expect(impact.trash.retentionDays).toBe(30);
    expect(impact.trash.items).toHaveLength(5000);
  });

  it('says nothing about the trash when the server did not', async () => {
    requestJson.mockResolvedValue({ shares: [] });

    const impact = await getDeleteImpact(selection(1));

    expect(impact).toEqual({ shareCount: 0, shares: [], trash: null });
  });
});
