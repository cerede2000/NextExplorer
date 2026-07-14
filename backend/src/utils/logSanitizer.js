const SENSITIVE_QUERY_PARAMETERS = new Set([
  'access_token',
  'code',
  'client_secret',
  'id_token',
  'logout_token',
  'refresh_token',
  'state',
  'token',
]);

const REDACTED = '[redacted]';

const isSensitiveKey = (key) => SENSITIVE_QUERY_PARAMETERS.has(String(key).toLowerCase());

const sanitizeLogUrl = (value) => {
  if (typeof value !== 'string' || !value) return value;

  try {
    const parsed = new URL(value, 'http://next-explorer.invalid');
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(key)) parsed.searchParams.set(key, REDACTED);
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (_) {
    return value;
  }
};

const sanitizeLogHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return headers;

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) =>
      ['authorization', 'cookie', 'set-cookie'].includes(key.toLowerCase())
        ? [key, REDACTED]
        : [key, value]
    )
  );
};

const sanitizeLogQuery = (query) => {
  if (!query || typeof query !== 'object') return query;

  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [key, isSensitiveKey(key) ? REDACTED : value])
  );
};

const sanitizeHttpRequestForLog = (request) => ({
  ...request,
  url: sanitizeLogUrl(request.url),
  headers: sanitizeLogHeaders(request.headers),
  query: sanitizeLogQuery(request.query),
});

module.exports = {
  sanitizeLogUrl,
  sanitizeHttpRequestForLog,
};
