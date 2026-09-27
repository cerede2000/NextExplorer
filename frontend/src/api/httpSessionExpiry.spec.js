import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestJson, setErrorHandler, setSessionExpiredHandler } from './http';

/**
 * What a 401 does on its way out of the HTTP client.
 *
 * A 401 is not this request being wrong, it is the session being over — and
 * every other request in flight is about to say the same thing. Left to the
 * generic path it produced a toast each, twenty of them saying "authentication
 * required", which buries the one thing worth doing about it.
 *
 * So the client offers the 401 to a handler first. When that handler takes
 * responsibility, the toast is skipped and the error carries a flag saying why,
 * for a caller that wants to tell this apart from a request it got wrong.
 */

let fetchMock;
let toasts;
let expiries;

const failed = (status, body = {}) => ({ ok: false, status, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
  toasts = [];
  expiries = [];
  setErrorHandler((info) => {
    toasts.push(info);
    return info.message;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setErrorHandler(null);
  setSessionExpiredHandler(null);
});

const attempt = async () => {
  try {
    return { value: await requestJson('/api/browse/Documents') };
  } catch (error) {
    return { error };
  }
};

describe('a 401 the handler takes', () => {
  beforeEach(() => {
    setSessionExpiredHandler((info) => {
      expiries.push(info);
      return true;
    });
    fetchMock.mockResolvedValue(failed(401, { error: 'Authentication required.' }));
  });

  it('reaches the handler', async () => {
    await attempt();

    expect(expiries).toHaveLength(1);
  });

  it('raises no toast, because the handler is saying it once instead', async () => {
    await attempt();

    expect(toasts).toEqual([]);
  });

  it('still fails the request, so nothing carries on with no data', async () => {
    const { error } = await attempt();

    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(401);
  });

  /** So a caller can tell an ended session from a request it got wrong. */
  it('marks the failure as an ended session', async () => {
    const { error } = await attempt();

    expect(error.sessionExpired).toBe(true);
  });
});

describe('a 401 the handler declines', () => {
  beforeEach(() => {
    setSessionExpiredHandler(() => false);
    fetchMock.mockResolvedValue(failed(401, { error: 'Authentication required.' }));
  });

  /**
   * A guest, or a request that ran before the navigation guard could redirect.
   * Declining has to leave the ordinary path exactly as it was.
   */
  it('goes back to the ordinary error path', async () => {
    await attempt();

    expect(toasts).toHaveLength(1);
  });

  it('does not claim the session ended', async () => {
    const { error } = await attempt();

    expect(error.sessionExpired).toBeUndefined();
  });
});

describe('everything that is not a 401', () => {
  beforeEach(() => {
    setSessionExpiredHandler(() => true);
  });

  it('never reaches the handler on a 403', async () => {
    fetchMock.mockResolvedValue(failed(403, { error: 'Access denied.' }));

    await attempt();

    expect(expiries).toEqual([]);
  });

  it('never reaches the handler on a 404', async () => {
    fetchMock.mockResolvedValue(failed(404, { error: 'Not found.' }));

    await attempt();

    expect(expiries).toEqual([]);
  });

  it('still raises a toast for them', async () => {
    fetchMock.mockResolvedValue(failed(403, { error: 'Access denied.' }));

    await attempt();

    expect(toasts).toHaveLength(1);
  });
});

describe('with no handler registered at all', () => {
  /** Which is every test suite and every consumer written before this existed. */
  it('behaves exactly as it did', async () => {
    fetchMock.mockResolvedValue(failed(401, { error: 'Authentication required.' }));

    const { error } = await attempt();

    expect(toasts).toHaveLength(1);
    expect(error.statusCode).toBe(401);
  });
});

describe('a background request that opted out of toasts', () => {
  /**
   * A thumbnail suppresses the error handler so a missing file raises nothing.
   * The session ending is still worth knowing about, and there are dozens of
   * these in flight at once — which is exactly why the handler answers once.
   */
  it('still tells the handler the session ended', async () => {
    setSessionExpiredHandler((info) => {
      expiries.push(info);
      return true;
    });
    fetchMock.mockResolvedValue(failed(401, { error: 'Authentication required.' }));

    try {
      await requestJson('/api/thumbnails/x.jpg', { suppressErrorHandler: true });
    } catch (_) {
      // expected
    }

    expect(expiries).toHaveLength(1);
  });
});
