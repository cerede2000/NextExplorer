import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestJson, setErrorHandler, setSessionExpiredHandler } from './http';

/**
 * A request that gets no response at all, and what it means.
 *
 * An expired session was supposed to be answered by the 401 handler. On a
 * deployment behind an authenticating proxy it never got the chance: the proxy
 * answers the expired call itself, with a redirect to the identity provider on
 * another origin. Fetch follows it, that origin sends no CORS headers, and the
 * browser reports `TypeError: Failed to fetch` — the same thing it reports for
 * a server that is simply unreachable.
 *
 * So the client stopped calling it a network failure until it has asked. The
 * one endpoint that can answer without a session says whether the session is
 * over; only if it says the session is fine does the network message stand.
 *
 * The first version of this fix had no such probe and asserted, in its own
 * commit message, that "the server was already answering correctly". It was —
 * and the answer never arrived, which is exactly the gap these cover.
 */

let fetchMock;
let toasts;
let expiries;

const AUTH_STATUS = '/api/auth/status';
const isProbe = (url) => String(url).includes(AUTH_STATUS);

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  type: 'basic',
  json: async () => body,
});

/** What fetch produces when a response never arrives. */
const noResponse = () => Promise.reject(new TypeError('Failed to fetch'));

/** A signed-in visitor, and one whose session has run out. */
const SIGNED_IN = { authEnabled: true, authenticated: true };
const SIGNED_OUT = { authEnabled: true, authenticated: false };

/**
 * Fails the request under test and answers the probe however a test asks.
 * Retries are disabled so a test spends no time on the backoff.
 */
const withProbe = (probeResult) => {
  fetchMock.mockImplementation((url) => {
    if (isProbe(url)) return probeResult();
    return noResponse();
  });
};

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
  setSessionExpiredHandler(() => {
    expiries.push(true);
    return true;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setErrorHandler(null);
  setSessionExpiredHandler(null);
});

const attempt = async () => {
  try {
    return { value: await requestJson('/api/browse/Documents', { retryNetworkErrors: false }) };
  } catch (error) {
    return { error };
  }
};

describe('every API request', () => {
  /**
   * The header an authenticating proxy reads to decide between answering 401
   * and redirecting a browser to a sign-in page. Without it the redirect is the
   * default, and a redirect is what a fetch cannot survive.
   */
  it('says it is a program asking, not a person navigating', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));

    await attempt();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('lets a caller override that header', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));

    await requestJson('/api/browse/Documents', { headers: { 'X-Requested-With': 'something' } });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Requested-With']).toBe('something');
  });
});

describe('a request that gets no response', () => {
  it('asks whether the session is still there', async () => {
    withProbe(() => Promise.resolve(json(SIGNED_OUT)));

    await attempt();

    expect(fetchMock.mock.calls.some(([url]) => isProbe(url))).toBe(true);
  });

  it('goes to the login screen when the session has ended', async () => {
    withProbe(() => Promise.resolve(json(SIGNED_OUT)));

    await attempt();

    expect(expiries).toHaveLength(1);
  });

  it('says so on the error rather than calling it a network failure', async () => {
    withProbe(() => Promise.resolve(json(SIGNED_OUT)));

    const { error } = await attempt();

    expect(error.sessionExpired).toBe(true);
    expect(error.statusCode).toBe(401);
  });

  /** The wall of red toasts is the thing being removed. */
  it('raises no toast about CORS or PUBLIC_URL', async () => {
    withProbe(() => Promise.resolve(json(SIGNED_OUT)));

    await attempt();

    expect(toasts).toEqual([]);
  });

  /**
   * The proxy answered the call itself. Our own status endpoint never
   * redirects, so a redirect here can only have come from something in front of
   * it — which is the case that produced the CORS message.
   */
  it('treats a diverted probe as the session being over', async () => {
    withProbe(() => Promise.resolve({ ok: false, status: 0, type: 'opaqueredirect' }));

    await attempt();

    expect(expiries).toHaveLength(1);
  });

  it('treats a probe that gets nowhere as the session being over', async () => {
    withProbe(() => noResponse());

    await attempt();

    expect(expiries).toHaveLength(1);
  });

  it('treats a 401 on the probe as the session being over', async () => {
    withProbe(() => Promise.resolve(json({}, 401)));

    await attempt();

    expect(expiries).toHaveLength(1);
  });
});

describe('a request that gets no response while the session is fine', () => {
  /**
   * The network really was the problem. Sending somebody to a login screen for
   * a dropped connection would be a worse bug than the one being fixed: they
   * would lose the page they were on and gain nothing.
   */
  it('leaves the login screen alone', async () => {
    withProbe(() => Promise.resolve(json(SIGNED_IN)));

    await attempt();

    expect(expiries).toEqual([]);
  });

  it('reports the network failure as before', async () => {
    withProbe(() => Promise.resolve(json(SIGNED_IN)));

    await attempt();

    expect(toasts.map((t) => t.message)).toEqual(['Network Error']);
  });

  /** With authentication switched off, nobody has a session to lose. */
  it('leaves an installation without accounts alone', async () => {
    withProbe(() => Promise.resolve(json({ authEnabled: false, authenticated: true })));

    await attempt();

    expect(expiries).toEqual([]);
  });
});

describe('when everything in flight fails at once', () => {
  /**
   * Twenty failed requests are one expired session. Asking twenty times would
   * turn a diagnosis into a burst of traffic at the exact moment the gateway is
   * refusing everything.
   */
  it('asks once, not once per request', async () => {
    withProbe(() => Promise.resolve(json(SIGNED_OUT)));

    await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);

    expect(fetchMock.mock.calls.filter(([url]) => isProbe(url))).toHaveLength(1);
  });

  it('still answers every one of them', async () => {
    withProbe(() => Promise.resolve(json(SIGNED_OUT)));

    const results = await Promise.all([attempt(), attempt(), attempt()]);

    expect(results.every((r) => r.error?.sessionExpired)).toBe(true);
  });

  /** A later failure asks again: the first answer was about the first moment. */
  it('asks again for a failure that comes later', async () => {
    withProbe(() => Promise.resolve(json(SIGNED_OUT)));

    await attempt();
    await attempt();

    expect(fetchMock.mock.calls.filter(([url]) => isProbe(url))).toHaveLength(2);
  });
});
