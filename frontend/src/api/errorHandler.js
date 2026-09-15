/**
 * Codes that say what kind of refusal it was, not which one. The catalogue
 * gives the kind in the reader's language; the server's own sentence, which
 * says which refusal, goes underneath rather than being lost.
 */
const GENERIC_CODES = new Set(['FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMIT_EXCEEDED']);

export function createErrorHandler(notificationsStore, i18n) {
  // Asked before translating: vue-i18n warns in the console for every key it
  // is asked for and does not have, twice with a fallback locale, and most
  // codes the server sends have no entry.
  const knows = (key) => i18n.global.te(key) || i18n.global.te(key, 'en');

  return (errorInfo) => {
    const { code, message, requestId, statusCode, details } = errorInfo;

    let heading = message || 'An error occurred';
    let explanation = null;

    // Translate if we have a code
    if (code) {
      const key = `serverErrors.${code}`;

      if (knows(key)) {
        // Handle rate limit pluralization
        if (code.startsWith('RATE_LIMIT_') && details?.retryAfter) {
          const minutes = Math.ceil(details.retryAfter / 60);
          heading = i18n.global.t(key, { minutes }, minutes);
        } else if (code === 'AUTH_ACCOUNT_LOCKED' && details?.retryAfter) {
          // A sentence of its own rather than a placeholder in the plain one:
          // a lock that arrives without a duration must never read "{minutes}".
          const minutes = Math.ceil(details.retryAfter / 60);
          heading = i18n.global.t('serverErrors.AUTH_ACCOUNT_LOCKED_RETRY', { minutes }, minutes);
        } else {
          heading = i18n.global.t(key);
        }
        if (GENERIC_CODES.has(code) && message) explanation = message;
      }
    }

    const body = [explanation, details ? JSON.stringify(details) : null].filter(Boolean).join('\n');

    notificationsStore.addNotification({
      type: 'error',
      heading,
      body,
      requestId,
      statusCode,
    });

    // Return translated message for error thrown by http.js
    return heading;
  };
}
