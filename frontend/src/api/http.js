const DEFAULT_API_BASE = '/';
const apiBase = (import.meta.env.VITE_API_URL || DEFAULT_API_BASE).replace(/\/$/, '');
const NETWORK_RETRY_DELAYS_MS = [300, 900];

const buildUrl = (endpoint) => `${apiBase}${endpoint}`;

let errorHandler = null;
export const setErrorHandler = (handler) => {
  errorHandler = handler;
};

/**
 * What to do when the server says the session is gone.
 *
 * Registered rather than imported so this module keeps knowing nothing about
 * the router or the stores. It returns true when it has taken responsibility,
 * which is what stops the generic error toast: one expired session fails every
 * request in flight, and twenty toasts saying "authentication required" bury
 * the only useful thing to say.
 */
let sessionExpiredHandler = null;
export const setSessionExpiredHandler = (handler) => {
  sessionExpiredHandler = handler;
};

const encodePath = (relativePath = '') => {
  if (!relativePath) return '';
  return relativePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
};

const normalizePath = (relativePath = '') => {
  if (!relativePath) {
    return '';
  }
  // Remove leading and trailing slashes
  return relativePath.replace(/^\/+|\/+$/g, '');
};

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

/**
 * Whether the session is over, asked of the one endpoint that can still answer.
 *
 * A request that gets no response at all looks identical whether the server is
 * unreachable or something in front of it diverted the call to a sign-in page
 * on another origin. The browser reports the same `TypeError` for both, and the
 * message it produced blamed CORS and PUBLIC_URL for what was only a session
 * running out.
 *
 * `/api/auth/status` settles it. It is reachable without a session — the
 * authentication middleware lets `/api/auth` through before it checks anything
 * — and it reports whether this visitor still has one. Three answers matter:
 *
 *  - it says nobody is signed in, so the session ended;
 *  - it does not answer either, or answers with a redirect, so something is
 *    intercepting every call and a sign-in is the only way back;
 *  - it says the session is fine, so the failure was the network's, and the
 *    original message stands.
 *
 * `redirect: 'manual'` is safe on this one endpoint: it never redirects, so an
 * opaque redirect can only have come from something else. It is not applied to
 * requests in general, where a share link legitimately redirects.
 */
let sessionProbe = null;

const sessionHasEnded = () => {
  // One expired session fails everything in flight, and they all arrive here
  // together. They share the answer rather than each asking for it.
  if (!sessionProbe) {
    sessionProbe = askWhetherSessionEnded().finally(() => {
      sessionProbe = null;
    });
  }
  return sessionProbe;
};

const askWhetherSessionEnded = async () => {
  try {
    const response = await fetch(buildUrl('/api/auth/status'), {
      method: 'GET',
      credentials: 'include',
      redirect: 'manual',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    // Diverted before it reached us. Nothing else explains a redirect here.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return true;
    }
    if (!response.ok) return response.status === 401;

    const status = await response.json();
    return status?.authEnabled === true && status?.authenticated === false;
  } catch (_) {
    // Even this got nowhere. Somebody signed in a moment ago cannot reach the
    // one endpoint that needs no session, which is a gateway turning everything
    // away rather than a server that has gone quiet.
    return true;
  }
};

// A cancelled request never reaches here: the caller's abort is checked as soon
// as the failure is caught, above, and rethrown there. One place decides it.
const shouldRetryNetworkError = (method, attempt, options = {}) => {
  if (options.retryNetworkErrors === false) return false;
  // A small number of read-like POST endpoints (batch lookups) are explicitly
  // marked idempotent by their caller. Retrying those is safe, while writes
  // remain protected from accidental duplicate operations.
  if (method !== 'GET' && method !== 'HEAD' && options.retryNetworkErrors !== true) return false;
  return attempt < NETWORK_RETRY_DELAYS_MS.length;
};

const requestRaw = async (endpoint, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.headers || {}),
  };

  if (method !== 'GET' && method !== 'HEAD' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  // Says "this is a program asking, not a person navigating".
  //
  // An authenticating proxy in front of the application — Authelia, Authentik,
  // oauth2-proxy — answers an expired session with a redirect to the identity
  // provider, which is right for a browser following a link and useless here:
  // fetch follows it to another origin, that origin sends no CORS headers, and
  // the browser reports a network failure with nothing in it about a session.
  // All of them answer 401 instead when they see this header, which is the
  // answer this client knows what to do with.
  if (!headers['X-Requested-With']) {
    headers['X-Requested-With'] = 'XMLHttpRequest';
  }

  // Add guest session header if present
  const guestSessionId = sessionStorage.getItem('guestSessionId');
  if (guestSessionId) {
    headers['X-Guest-Session'] = guestSessionId;
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(buildUrl(endpoint), {
        credentials: options.credentials || 'include', // All requests rely on cookies
        ...options,
        method,
        headers,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = errorData?.error;

        const errorInfo = {
          statusCode: response.status,
          ...(typeof error === 'object'
            ? error
            : { message: error || `Request failed with status ${response.status}` }),
        };

        // A 401 is not this request being wrong, it is the session being over —
        // and every other request in flight is about to say the same thing. The
        // handler answers once, by taking the person to the login screen.
        if (response.status === 401 && sessionExpiredHandler?.(errorInfo)) {
          const expired = new Error(errorInfo.message);
          expired.statusCode = 401;
          expired.sessionExpired = true;
          throw expired;
        }

        // Best-effort / background requests (e.g. thumbnails) opt out of the
        // global error handler so a missing file does not raise a user-facing
        // toast. The status code is still attached so callers can react.
        const translatedMessage = options.suppressErrorHandler
          ? errorInfo.message
          : errorHandler?.(errorInfo) || errorInfo.message;
        const requestError = new Error(translatedMessage);
        requestError.statusCode = response.status;
        if (errorInfo.code) requestError.code = errorInfo.code;
        throw requestError;
      }

      return response;
    } catch (error) {
      // An explicit user cancellation must preserve the browser's abort error.
      // Recasting it as a network/CORS failure would show a misleading alert and
      // prevent callers from treating cancellation as a normal outcome. This is
      // also what keeps a cancelled request from being retried: a torn-down
      // connection is reported as a TypeError, indistinguishable from a server
      // that was never reached.
      if (options.signal?.aborted) throw error;
      if (error instanceof TypeError) {
        if (shouldRetryNetworkError(method, attempt, options)) {
          await wait(NETWORK_RETRY_DELAYS_MS[attempt]);
          continue;
        }

        const targetUrl = buildUrl(endpoint);

        // Before calling it a network failure, find out whether it was only the
        // session. The handler answers once for every request in flight, so
        // asking here costs one extra call and not one per failure.
        if (sessionExpiredHandler && (await sessionHasEnded()) && sessionExpiredHandler()) {
          const expired = new Error('Session expired');
          expired.statusCode = 401;
          expired.sessionExpired = true;
          throw expired;
        }

        if (options.suppressErrorHandler) {
          throw error;
        }
        const translatedMessage =
          errorHandler?.({
            message: 'Network Error',
            details: {
              message:
                'The browser did not receive a response. Check the endpoint and browser context below before assuming a PUBLIC_URL/CORS issue.',
              endpoint: targetUrl,
              method,
              attempts: attempt + 1,
              browserOrigin: globalThis.location?.origin || null,
              browserOnline: globalThis.navigator?.onLine ?? null,
              nativeMessage: error.message || null,
            },
          }) || 'Network Error';
        throw new Error(translatedMessage);
      }
      throw error;
    }
  }
};

const requestJson = async (endpoint, options = {}) => {
  const response = await requestRaw(endpoint, options);
  if (response.status === 204) {
    return null;
  }
  return response.json();
};

// Consume a newline-delimited JSON (NDJSON) response, invoking `onEvent` for
// each streamed event and resolving with the final `{type:'done', ...}` payload.
// A `{type:'error', ...}` line is turned into a thrown Error routed through the
// global error handler, matching requestJson's behaviour. Pre-flight failures
// (non-2xx) are still handled by requestRaw before streaming begins.
const requestStream = async (endpoint, { onEvent, suppressErrorCodes = [], ...options } = {}) => {
  const response = await requestRaw(endpoint, options);

  const reader = response.body?.getReader?.();
  if (!reader) {
    // No readable stream available: fall back to a single JSON parse.
    return response.json().catch(() => null);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  let streamError = null;

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      return;
    }

    if (event.type === 'error') {
      streamError = event;
    } else if (event.type === 'done') {
      result = event;
    } else if (typeof onEvent === 'function') {
      onEvent(event);
    }
  };

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  }
  buffer += decoder.decode();
  handleLine(buffer);

  if (streamError) {
    const errorInfo = {
      statusCode: streamError.statusCode || 500,
      message: streamError.message || 'Request failed',
      code: streamError.code,
    };
    const suppressErrorHandler =
      options.suppressErrorHandler || suppressErrorCodes.includes(errorInfo.code);
    const translatedMessage = suppressErrorHandler
      ? errorInfo.message
      : errorHandler?.(errorInfo) || errorInfo.message;
    const error = new Error(translatedMessage);
    if (streamError.code) error.code = streamError.code;
    throw error;
  }

  return result;
};

export { apiBase, buildUrl, encodePath, normalizePath, requestJson, requestRaw, requestStream };
