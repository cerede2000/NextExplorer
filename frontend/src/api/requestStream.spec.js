import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestStream, setErrorHandler } from './http';
import { compressToZip, extractZip } from './files.api';

/**
 * Reading a streamed answer, line by line.
 *
 * Extracting and compressing report their progress as newline-delimited JSON:
 * one event per line, then `done` or `error`. Read as a single JSON document,
 * that answer throws on its second line, so the archive was made on the server
 * while the view reported a failure and never showed it.
 *
 * The parsing has to survive the network rather than the parser: a chunk
 * boundary falls wherever TCP puts it, so a single event routinely arrives
 * split across two reads, and a reader that assumes one chunk is one line
 * drops events or throws on half of one.
 *
 * The event kinds are three and they are not interchangeable. `done` is the
 * return value, `error` is a throw, and everything else goes to the callback.
 * Treating a trailing `error` as an ordinary event resolves a failed
 * compression as a successful one.
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

    const result = await requestStream('/api/files/zip/compress', { onEvent: (e) => seen.push(e) });

    expect(seen.map((e) => e.type)).toEqual(['start', 'progress']);
    expect(result).toEqual({ type: 'done', items: ['a', 'b'] });
  });

  /** A failure that arrives mid-stream is a failure, not an event. */
  it('throws on an error line rather than resolving', async () => {
    fetchMock.mockResolvedValue(
      lines({ type: 'progress', completedItems: 1 }, { type: 'error', message: 'Disk full' })
    );

    await expect(requestStream('/api/files/zip/compress', { onEvent: () => {} })).rejects.toThrow(
      'Disk full'
    );
  });

  it('throws even when a done line came first', async () => {
    fetchMock.mockResolvedValue(
      lines({ type: 'done', items: ['a'] }, { type: 'error', message: 'Disk full' })
    );

    await expect(requestStream('/api/files/zip/compress')).rejects.toThrow('Disk full');
  });

  it('carries the code from an error line', async () => {
    fetchMock.mockResolvedValue(
      lines({ type: 'error', message: 'Denied', code: 'FORBIDDEN', statusCode: 403 })
    );

    const error = await requestStream('/api/files/zip/compress').catch((e) => e);

    expect(error.code).toBe('FORBIDDEN');
  });

  it('answers null when the stream ends without a done line', async () => {
    fetchMock.mockResolvedValue(lines({ type: 'progress', completedItems: 1 }));

    expect(await requestStream('/api/files/zip/compress', { onEvent: () => {} })).toBeNull();
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

    const result = await requestStream('/api/files/zip/compress', { onEvent: (e) => seen.push(e) });

    expect(seen).toEqual([{ type: 'progress', completedItems: 7 }]);
    expect(result).toMatchObject({ type: 'done' });
  });

  it('reads several events out of one chunk', async () => {
    const seen = [];
    fetchMock.mockResolvedValue(
      streamOf('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n{"type":"done"}\n')
    );

    await requestStream('/api/files/zip/compress', { onEvent: (e) => seen.push(e) });

    expect(seen.map((e) => e.type)).toEqual(['a', 'b', 'c']);
  });

  /** A server that does not end on a newline still sent that last event. */
  it('takes the final event even without a trailing newline', async () => {
    fetchMock.mockResolvedValue(streamOf('{"type":"progress"}\n{"type":"done","items":["x"]}'));

    const result = await requestStream('/api/files/zip/compress', { onEvent: () => {} });

    expect(result).toMatchObject({ items: ['x'] });
  });

  it('ignores blank lines, which a keep-alive may send', async () => {
    const seen = [];
    fetchMock.mockResolvedValue(streamOf('\n\n{"type":"progress"}\n\n{"type":"done"}\n'));

    await requestStream('/api/files/zip/compress', { onEvent: (e) => seen.push(e) });

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

    const result = await requestStream('/api/files/zip/compress', { onEvent: (e) => seen.push(e) });

    expect(seen).toHaveLength(1);
    expect(result).toMatchObject({ type: 'done' });
  });

  it('handles a multi-byte character split across chunks', async () => {
    const bytes = encoder.encode('{"type":"done","name":"café"}\n');
    // Between the two bytes of the é.
    const split = encoder.encode('{"type":"done","name":"caf').length + 1;
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

    expect(await requestStream('/api/files/zip/compress')).toMatchObject({ name: 'café' });
  });
});

describe('when the response cannot be streamed', () => {
  /** Some environments and some proxies deliver the body whole. */
  it('falls back to reading it as one JSON document', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: ['a'] }) });

    expect(await requestStream('/api/files/zip/compress')).toEqual({ items: ['a'] });
  });

  it('answers null rather than throwing when that body is not JSON either', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });

    expect(await requestStream('/api/files/zip/compress')).toBeNull();
  });
});

describe('which failures reach the person', () => {
  it('translates the message through the global handler', async () => {
    setErrorHandler(({ code }) => (code === 'DISK_FULL' ? 'Disque plein' : null));
    fetchMock.mockResolvedValue(lines({ type: 'error', message: 'Disk full', code: 'DISK_FULL' }));

    await expect(requestStream('/api/files/zip/compress')).rejects.toThrow('Disque plein');
  });

  it('says something when the error line carries no message', async () => {
    fetchMock.mockResolvedValue(lines({ type: 'error' }));

    await expect(requestStream('/api/files/zip/compress')).rejects.toThrow(/failed/i);
  });
});

describe('the archive calls', () => {
  /** What the server sends: a start line, progress lines, then done. */
  const archiveAnswer = (item) =>
    lines(
      { type: 'start', name: item.name },
      { type: 'progress', percent: 50 },
      { type: 'done', success: true, item }
    );

  it('compressing resolves with the archive the server made', async () => {
    fetchMock.mockResolvedValue(archiveAnswer({ name: 'Work (1).zip', kind: 'zip' }));

    const result = await compressToZip([{ name: 'one.txt', path: 'files/Work' }], 'files/Work');

    expect(result).toMatchObject({ type: 'done', item: { name: 'Work (1).zip' } });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/files\/zip\/compress$/);
  });

  it('extracting resolves with the folder the server made', async () => {
    fetchMock.mockResolvedValue(archiveAnswer({ name: 'one', kind: 'directory' }));

    const result = await extractZip('files/Work/one.zip');

    expect(result).toMatchObject({ type: 'done', item: { name: 'one' } });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/files\/zip\/extract$/);
  });

  it('a compression that fails half way is a failure, not a success', async () => {
    fetchMock.mockResolvedValue(
      lines({ type: 'start', name: 'Work.zip' }, { type: 'error', message: 'Disk full' })
    );

    await expect(
      compressToZip([{ name: 'one.txt', path: 'files/Work' }], 'files/Work')
    ).rejects.toThrow('Disk full');
  });
});
