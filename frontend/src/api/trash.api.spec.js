import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The trash endpoints, as the screens call them. Nothing is decided here; what
 * matters is that each action reaches the endpoint that performs it, with the
 * body the server reads — a restore sent to the delete endpoint would be the
 * worst possible typo.
 */

const { requestJson, requestStream } = vi.hoisted(() => ({
  requestJson: vi.fn(async () => ({})),
  requestStream: vi.fn(async () => ({})),
}));

vi.mock('./http', () => ({ requestJson, requestStream }));

const api = await import('./trash.api');

const call = () => {
  const [endpoint, options] = requestJson.mock.calls.at(-1);
  return {
    endpoint,
    method: options?.method,
    body: options?.body ? JSON.parse(options.body) : null,
  };
};

beforeEach(() => {
  requestJson.mockClear();
});

describe('the trash API', () => {
  it('lists what the trash holds', async () => {
    await api.getTrash();

    expect(call()).toEqual({ endpoint: '/api/trash', method: 'GET', body: null });
  });

  it('restores the chosen items', async () => {
    await api.restoreTrashItems(['a', 'b']);

    expect(call()).toEqual({
      endpoint: '/api/trash/restore',
      method: 'POST',
      body: { ids: ['a', 'b'] },
    });
  });

  it('opens a deleted folder, at its top or further in', async () => {
    await api.getTrashEntries('id 1');
    expect(call()).toEqual({
      endpoint: '/api/trash/items/id%201/entries',
      method: 'GET',
      body: null,
    });

    await api.getTrashEntries('a', 'drafts/v 2');
    expect(call().endpoint).toBe('/api/trash/items/a/entries?path=drafts%2Fv%202');
  });

  it('restores entries from inside a deleted folder', async () => {
    await api.restoreTrashEntries('a', ['drafts/v2.txt']);

    expect(call()).toEqual({
      endpoint: '/api/trash/items/a/restore',
      method: 'POST',
      body: { paths: ['drafts/v2.txt'] },
    });
  });

  it('restores items into a chosen folder, as a stream it can follow and cancel', async () => {
    const onEvent = vi.fn();
    const { signal } = new AbortController();

    await api.restoreTrashItemsTo(['a'], 'Archive', { onEvent, signal });

    const [endpoint, options] = requestStream.mock.calls.at(-1);
    expect(endpoint).toBe('/api/trash/restore-to');
    expect(options).toMatchObject({ method: 'POST', onEvent, signal });
    expect(JSON.parse(options.body)).toEqual({ ids: ['a'], destination: 'Archive' });
  });

  it('restores entries of a deleted folder into a chosen folder, the same way', async () => {
    await api.restoreTrashEntriesTo('id 1', ['drafts/v2.txt'], 'Archive');

    const [endpoint, options] = requestStream.mock.calls.at(-1);
    expect(endpoint).toBe('/api/trash/items/id%201/restore-to');
    expect(JSON.parse(options.body)).toEqual({ paths: ['drafts/v2.txt'], destination: 'Archive' });
  });

  it('deletes the chosen items for good', async () => {
    await api.deleteTrashItems(['a']);

    expect(call()).toEqual({ endpoint: '/api/trash/delete', method: 'POST', body: { ids: ['a'] } });
  });

  it('asks to forget unavailable items only when told to', async () => {
    await api.deleteTrashItems(['a'], { forgetUnavailable: true });

    expect(call().body).toEqual({ ids: ['a'], forgetUnavailable: true });
  });

  it('empties the trash', async () => {
    await api.emptyTrash();

    expect(call()).toEqual({ endpoint: '/api/trash/empty', method: 'POST', body: {} });
  });

  it('reads the zones, verifies them and runs the maintenance', async () => {
    await api.getTrashZones();
    expect(call()).toEqual({ endpoint: '/api/trash/zones', method: 'GET', body: null });

    await api.verifyTrash();
    expect(call().endpoint).toBe('/api/trash/verify');

    await api.runTrashMaintenance();
    expect(call().endpoint).toBe('/api/trash/maintenance');
  });
});
