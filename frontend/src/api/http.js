const DEFAULT_API_BASE = '/';
const apiBase = (import.meta.env.VITE_API_URL || DEFAULT_API_BASE).replace(/\/$/, '');
const NETWORK_RETRY_DELAYS_MS = [300, 900];

const buildUrl = (endpoint) => `${apiBase}${endpoint}`;

let errorHandler = null;
export const setErrorHandler = (handler) => {
  errorHandler = handler;
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

const shouldRetryNetworkError = (method, attempt, options = {}) => {
  if (options.retryNetworkErrors === false) return false;
  if (options.signal?.aborted) return false;
  if (method !== 'GET' && method !== 'HEAD') return false;
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

        const translatedMessage = errorHandler?.(errorInfo) || errorInfo.message;
        throw new Error(translatedMessage);
      }

      return response;
    } catch (error) {
      if (error instanceof TypeError) {
        if (shouldRetryNetworkError(method, attempt, options)) {
          await wait(NETWORK_RETRY_DELAYS_MS[attempt]);
          continue;
        }

        const translatedMessage =
          errorHandler?.({
            message: 'Network Error',
            details:
              'Failed to connect to server. This is often caused by a PUBLIC_URL/CORS mismatch or a reverse proxy configuration issue.',
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
const requestStream = async (endpoint, { onEvent, ...options } = {}) => {
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
    const translatedMessage = options.suppressErrorHandler
      ? errorInfo.message
      : errorHandler?.(errorInfo) || errorInfo.message;
    const error = new Error(translatedMessage);
    if (streamError.code) error.code = streamError.code;
    throw error;
  }

  return result;
};

export { apiBase, buildUrl, encodePath, normalizePath, requestJson, requestRaw, requestStream };
