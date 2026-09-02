import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The one module every request in the application goes through, at 12 % of its
 * statements and 2 % of its branches.
 *
 * What it decides is not visible from any single feature: whether a failed
 * request is tried again, whether a cancellation is reported as a cancellation
 * or as a network failure, and which errors reach the user at all. A defect
 * here does not break one screen — it misreports every one of them.
 */

import {
  buildUrl,
  encodePath,
  normalizePath,
  requestJson,
  requestRaw,
  setErrorHandler,
} from './http';

const ok = (body = {}, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const failed = (status, body = {}) => ({
  ok: false,
  status,
  json: async () => body,
});

/** What the browser throws when it never reached the server. */
const networkFailure = () => new TypeError('Failed to fetch');

let fetchMock;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  });
  setErrorHandler(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setErrorHandler(null);
});

/** Run the retry loop's waits without waiting for them. */
const settle = async (promise) => {
  const result = promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await vi.runAllTimersAsync();
  return result;
};

describe('paths on the way into a URL', () => {
  it('encodes each segment without encoding the separators', () => {
    expect(encodePath('Docs/holiday photos/#1.jpg')).toBe('Docs/holiday%20photos/%231.jpg');
  });

  it('drops empty segments rather than producing a double slash', () => {
    expect(encodePath('/Docs//notes.txt/')).toBe('Docs/notes.txt');
  });

  it('trims the slashes a caller may have left on', () => {
    expect(normalizePath('/Docs/notes/')).toBe('Docs/notes');
    expect(normalizePath('')).toBe('');
  });

  it('builds a URL against the configured base', () => {
    expect(buildUrl('/api/browse')).toMatch(/\/api\/browse$/);
  });
});

describe('a request the browser could not deliver', () => {
  it('tries a GET again, twice, before giving up', async () => {
    fetchMock.mockRejectedValue(networkFailure());

    const { error } = await settle(requestRaw('/api/browse'));

    // Three attempts: the first and the two retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(Error);
  });

  it('answers as soon as a retry succeeds', async () => {
    fetchMock.mockRejectedValueOnce(networkFailure()).mockResolvedValueOnce(ok({ items: [] }));

    const { value } = await settle(requestJson('/api/browse'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(value).toEqual({ items: [] });
  });

  /**
   * A write is not safe to repeat. Sending a delete twice because the answer
   * was lost is worse than reporting that it may not have happened.
   */
  it('never repeats a write on its own', async () => {
    fetchMock.mockRejectedValue(networkFailure());

    await settle(requestRaw('/api/files', { method: 'DELETE' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('repeats a write the caller has said is safe to repeat', async () => {
    fetchMock.mockRejectedValue(networkFailure());

    await settle(
      requestRaw('/api/folder-size/batch', { method: 'POST', retryNetworkErrors: true })
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the caller has switched it off', async () => {
    fetchMock.mockRejectedValue(networkFailure());

    await settle(requestRaw('/api/browse', { retryNetworkErrors: false }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a request the user cancelled', () => {
  /**
   * Recasting an abort as a network failure shows an alert for something the
   * user did on purpose, and stops callers treating cancellation as the normal
   * outcome it is.
   */
  it('keeps the abort rather than calling it a network failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    fetchMock.mockRejectedValue(abortError);

    const { error } = await settle(requestRaw('/api/browse', { signal: controller.signal }));

    expect(error.name).toBe('AbortError');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * A cancelled request can fail as a TypeError rather than an AbortError — the
   * connection is torn down mid-flight and the browser reports it the same way
   * it reports an unreachable server. That is the only shape that reaches the
   * retry decision, and without the guard the request the user just cancelled
   * is sent twice more.
   */
  it('does not retry a cancellation the browser reported as a network failure', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(networkFailure());

    const { error } = await settle(requestRaw('/api/browse', { signal: controller.signal }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The original failure, not one recast as a user-facing network error.
    expect(error).toBeInstanceOf(TypeError);
  });

  it('does not retry once the caller cancels mid-flight', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(networkFailure());
    });

    await settle(requestRaw('/api/browse', { signal: controller.signal }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('an answer the server refused', () => {
  it('carries the status and the code back to the caller', async () => {
    fetchMock.mockResolvedValue(
      failed(403, { error: { message: 'Path is not accessible.', code: 'FORBIDDEN' } })
    );

    const { error } = await settle(requestRaw('/api/browse/Private'));

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('Path is not accessible.');
  });

  it('says something useful when the body carries no message', async () => {
    fetchMock.mockResolvedValue(failed(500, {}));

    const { error } = await settle(requestRaw('/api/browse'));

    expect(error.message).toMatch(/500/);
    expect(error.statusCode).toBe(500);
  });

  it('never retries a refusal — the server answered', async () => {
    fetchMock.mockResolvedValue(failed(404, {}));

    await settle(requestRaw('/api/browse/gone'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the message the handler translated', async () => {
    setErrorHandler(({ code }) => (code === 'FORBIDDEN' ? 'Accès refusé' : null));
    fetchMock.mockResolvedValue(failed(403, { error: { message: 'Denied', code: 'FORBIDDEN' } }));

    const { error } = await settle(requestRaw('/api/browse/Private'));

    expect(error.message).toBe('Accès refusé');
  });

  /**
   * A thumbnail for a file that has gone must not raise a message. Background
   * requests opt out, and the status still reaches the caller so it can react.
   */
  it('leaves the handler out of it for a background request', async () => {
    const handler = vi.fn(() => 'translated');
    setErrorHandler(handler);
    fetchMock.mockResolvedValue(failed(404, { error: { message: 'Not found' } }));

    const { error } = await settle(
      requestRaw('/api/thumbnails/gone.png', { suppressErrorHandler: true })
    );

    expect(handler).not.toHaveBeenCalled();
    expect(error.message).toBe('Not found');
    expect(error.statusCode).toBe(404);
  });
});

describe('what comes back on success', () => {
  it('gives back nothing at all for a 204', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({ unread: true }) });

    const { value } = await settle(requestJson('/api/users/x', { method: 'DELETE' }));

    expect(value).toBeNull();
  });

  it('sends JSON as JSON without being told', async () => {
    fetchMock.mockResolvedValue(ok({}));

    await settle(requestJson('/api/users', { method: 'POST', body: '{}' }));

    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });

  it('leaves a content type the caller chose alone', async () => {
    fetchMock.mockResolvedValue(ok({}));

    await settle(
      requestJson('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    );

    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('multipart/form-data');
  });

  it('carries the guest session along when the visitor holds one', async () => {
    sessionStorage.getItem.mockReturnValue('guest-abc');
    fetchMock.mockResolvedValue(ok({}));

    await settle(requestJson('/api/share/abc/browse/'));

    expect(fetchMock.mock.calls[0][1].headers['X-Guest-Session']).toBe('guest-abc');
  });

  it('sends cookies, since every request relies on them', async () => {
    fetchMock.mockResolvedValue(ok({}));

    await settle(requestJson('/api/browse'));

    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });
});
