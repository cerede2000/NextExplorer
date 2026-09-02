import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestStream, setErrorHandler } from './http';

/**
 * Reading a streamed answer, line by line.
 *
 * Copy, move and delete report their progress as newline-delimited JSON, so
 * this is what drives every progress bar in the application. The parsing is the
 * part nothing covered, and it is the part that has to survive the network
 * rather than the parser: a chunk boundary falls wherever TCP puts it, so a
 * single event routinely arrives split across two reads, and a reader that
 * assumes one chunk is one line drops events or throws on half of one.
 *
 * The event kinds are three and they are not interchangeable. `done` is the
 * return value, `error` is a throw, and everything else goes to the callback.
 * Treating a trailing `error` as an ordinary event resolves a failed delete as
 * a successful one.
 */

const encoder = new TextEncoder();

/** A response whose body arrives in exactly these chunks. */
const streamOf = (...chunks) => ({
  ok: true,
  status: 200,
  body: {
    getReader: () => {
      let index = 0;
      return {
        read: async () =>
          index < chunks.length
            ? { done: false, value: encoder.encode(chunks[index++]) }
            : { done: true, value: undefined },
      };
    },
  },
  json: async () => ({ fallback: true }),
});

const lines = (...events) => streamOf(events.map((e) => `${JSON.stringify(e)}\n`).join(''));

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
  setErrorHandler(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setErrorHandler(null);
});

describe('the three kinds of line', () => {
  it('gives progress events to the callback and the done event back', async () => {
    const seen = [];
    fetchMock.mockResolvedValue(
      lines(
        { type: 'start', totalItems: 2 },
        { type: 'progress', completedItems: 1 },
        { type: 'done', items: ['a', 'b'] }
      )
    );

    const result = await requestStream('/api/files/copy', { onEvent: (e) => seen.push(e) });

    expect(seen.map((e) => e.type)).toEqual(['start', 'progress']);
    expect(result).toEqual({ type: 'done', items: ['a', 'b'] });
  });

  /** A failure that arrives mid-stream is a failure, not an event. */
  it('throws on an error line rather than resolving', async () => {
    fetchMock.mockResolvedValue(
      lines({ type: 'progress', completedItems: 1 }, { type: 'error', message: 'Disk full' })
    );

    await expect(requestStream('/api/files/copy', { onEvent: () => {} })).rejects.toThrow(
      'Disk full'
    );
  });

  it('throws even when a done line came first', async () => {
    fetchMock.mockResolvedValue(
      lines({ type: 'done', items: ['a'] }, { type: 'error', message: 'Disk full' })
    );

    await expect(requestStream('/api/files/copy')).rejects.toThrow('Disk full');
  });

  it('carries the code from an error line', async () => {
    fetchMock.mockResolvedValue(
      lines({ type: 'error', message: 'Denied', code: 'FORBIDDEN', statusCode: 403 })
    );

    const error = await requestStream('/api/files/copy').catch((e) => e);

    expect(error.code).toBe('FORBIDDEN');
  });

  it('answers null when the stream ends without a done line', async () => {
    fetchMock.mockResolvedValue(lines({ type: 'progress', completedItems: 1 }));

    expect(await requestStream('/api/files/copy', { onEvent: () => {} })).toBeNull();
  });
});

describe('lines that do not arrive whole', () => {
  /**
   * The case this parsing exists for. A chunk boundary falls where the network
   * puts it, not where the events end.
   */
  it('reassembles an event split across two chunks', async () => {
    const seen = [];
    fetchMock.mockResolvedValue(
      streamOf('{"type":"progress","completed', 'Items":7}\n{"type":"done","items":[]}\n')
    );

    const result = await requestStream('/api/files/copy', { onEvent: (e) => seen.push(e) });

    expect(seen).toEqual([{ type: 'progress', completedItems: 7 }]);
    expect(result).toMatchObject({ type: 'done' });
  });

  it('reads several events out of one chunk', async () => {
    const seen = [];
    fetchMock.mockResolvedValue(
      streamOf('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n{"type":"done"}\n')
    );

    await requestStream('/api/files/copy', { onEvent: (e) => seen.push(e) });

    expect(seen.map((e) => e.type)).toEqual(['a', 'b', 'c']);
  });

  /** A server that does not end on a newline still sent that last event. */
  it('takes the final event even without a trailing newline', async () => {
    fetchMock.mockResolvedValue(streamOf('{"type":"progress"}\n{"type":"done","items":["x"]}'));

    const result = await requestStream('/api/files/copy', { onEvent: () => {} });

    expect(result).toMatchObject({ items: ['x'] });
  });

  it('ignores blank lines, which a keep-alive may send', async () => {
    const seen = [];
    fetchMock.mockResolvedValue(streamOf('\n\n{"type":"progress"}\n\n{"type":"done"}\n'));

    await requestStream('/api/files/copy', { onEvent: (e) => seen.push(e) });

    expect(seen).toHaveLength(1);
  });

  /**
   * A proxy injecting an HTML fragment mid-stream must not end the operation:
   * the events around it are still good.
   */
  it('skips a line that is not JSON and carries on', async () => {
    const seen = [];
    fetchMock.mockResolvedValue(
      streamOf('{"type":"progress"}\n<html>oops</html>\n{"type":"done","items":[]}\n')
    );

    const result = await requestStream('/api/files/copy', { onEvent: (e) => seen.push(e) });

    expect(seen).toHaveLength(1);
    expect(result).toMatchObject({ type: 'done' });
  });

  it('handles a multi-byte character split across chunks', async () => {
    const bytes = encoder.encode('{"type":"done","name":"café"}\n');
    const split = 24; // inside the é
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          const parts = [bytes.slice(0, split), bytes.slice(split)];
          let i = 0;
          return {
            read: async () =>
              i < parts.length ? { done: false, value: parts[i++] } : { done: true },
          };
        },
      },
    });

    expect(await requestStream('/api/files/copy')).toMatchObject({ name: 'café' });
  });
});

describe('when the response cannot be streamed', () => {
  /** Some environments and some proxies deliver the body whole. */
  it('falls back to reading it as one JSON document', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: ['a'] }) });

    expect(await requestStream('/api/files/copy')).toEqual({ items: ['a'] });
  });

  it('answers null rather than throwing when that body is not JSON either', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });

    expect(await requestStream('/api/files/copy')).toBeNull();
  });
});

describe('which failures reach the person', () => {
  it('translates the message through the global handler', async () => {
    setErrorHandler(({ code }) => (code === 'DISK_FULL' ? 'Disque plein' : null));
    fetchMock.mockResolvedValue(lines({ type: 'error', message: 'Disk full', code: 'DISK_FULL' }));

    await expect(requestStream('/api/files/copy')).rejects.toThrow('Disque plein');
  });

  /**
   * A caller expecting a particular failure — a cancelled operation, a name
   * clash it will resolve itself — silences just that one rather than the
   * handler entirely.
   */
  it('leaves the handler alone for a code the caller said it would handle', async () => {
    const handler = vi.fn(() => 'translated');
    setErrorHandler(handler);
    fetchMock.mockResolvedValue(
      lines({ type: 'error', message: 'Cancelled', code: 'OPERATION_CANCELLED' })
    );

    const error = await requestStream('/api/files/copy', {
      suppressErrorCodes: ['OPERATION_CANCELLED'],
    }).catch((e) => e);

    expect(handler).not.toHaveBeenCalled();
    expect(error.message).toBe('Cancelled');
    expect(error.code).toBe('OPERATION_CANCELLED');
  });

  it('still reports a code the caller did not silence', async () => {
    const handler = vi.fn(() => 'translated');
    setErrorHandler(handler);
    fetchMock.mockResolvedValue(lines({ type: 'error', message: 'Disk full', code: 'DISK_FULL' }));

    await expect(
      requestStream('/api/files/copy', { suppressErrorCodes: ['OPERATION_CANCELLED'] })
    ).rejects.toThrow('translated');
    expect(handler).toHaveBeenCalled();
  });

  it('says something when the error line carries no message', async () => {
    fetchMock.mockResolvedValue(lines({ type: 'error' }));

    await expect(requestStream('/api/files/copy')).rejects.toThrow(/failed/i);
  });
});
