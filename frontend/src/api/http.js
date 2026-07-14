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

        const targetUrl = buildUrl(endpoint);
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

export { apiBase, buildUrl, encodePath, normalizePath, requestJson, requestRaw };
