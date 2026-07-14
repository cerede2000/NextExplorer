const normalizeOrigin = (value) => {
  try {
    return new URL(value).origin;
  } catch (_) {
    return null;
  }
};

const uniqueOrigins = (origins) => [...new Set(origins.map(normalizeOrigin).filter(Boolean))];

/**
 * Only relative, same-site paths may be stored in the OIDC transaction state.
 * This protects the post-login redirect from becoming an open redirect.
 */
const sanitizeReturnTo = (candidate, fallback = '/browse/') => {
  if (typeof candidate !== 'string') return fallback;
  const value = candidate.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
};

const readForwardedHost = (req) => {
  const forwarded = req.headers?.['x-forwarded-host'];
  if (typeof forwarded !== 'string') return null;
  return forwarded.split(',')[0]?.trim() || null;
};

/**
 * Resolve the browser-facing origin, but only when it exactly matches an
 * operator-configured public or internal origin. A forwarded host is useful
 * behind a trusted proxy; the allow-list prevents it from becoming a redirect
 * target controlled by a request header.
 */
const getConfiguredRequestOrigin = (req, allowedOrigins) => {
  const host = readForwardedHost(req) || req.get?.('host') || req.headers?.host;
  if (!host) return null;

  try {
    const origin = new URL(`${req.protocol || 'http'}://${host}`).origin;
    return allowedOrigins.includes(origin) ? origin : null;
  } catch (_) {
    return null;
  }
};

const absoluteReturnTo = (origin, candidate) =>
  new URL(sanitizeReturnTo(candidate, '/auth/login'), origin).toString();

module.exports = {
  uniqueOrigins,
  sanitizeReturnTo,
  getConfiguredRequestOrigin,
  absoluteReturnTo,
};
