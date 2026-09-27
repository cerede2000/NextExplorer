/**
 * Centralized error code constants for client-side localization
 * These codes are sent to the frontend to map to translated messages
 */
const ErrorCodes = {
  // Authentication (401)
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  // The second step of a sign-in, so a screen can say "that code" rather than
  // "those credentials" — the password was right, and saying otherwise sends
  // somebody looking for the wrong mistake.
  AUTH_INVALID_TOTP_CODE: 'AUTH_INVALID_TOTP_CODE',
  AUTH_ACCOUNT_LOCKED: 'AUTH_ACCOUNT_LOCKED',
  AUTH_PASSWORD_INCORRECT: 'AUTH_PASSWORD_INCORRECT',
  // A passkey that did not open anything: the wrong site, a stale question, a
  // signature that does not hold, or a credential this server has never seen.
  // One code for all of them, because telling them apart would answer which
  // passkeys exist here to whoever asks.
  AUTH_PASSKEY_REJECTED: 'AUTH_PASSKEY_REJECTED',
  // The browser cannot do this: no passkey support, or a page that is not on a
  // secure origin, which is a setup problem rather than a wrong answer.
  AUTH_PASSKEY_UNAVAILABLE: 'AUTH_PASSKEY_UNAVAILABLE',

  // An API token: not valid at all, or valid and reaching for something no
  // token may reach. One code for every way the first can happen — see
  // middleware/apiTokenAuth.js for why the reason is written in the log and
  // never in the answer.
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_NOT_ALLOWED: 'AUTH_TOKEN_NOT_ALLOWED',
  AUTH_TOKEN_READ_ONLY: 'AUTH_TOKEN_READ_ONLY',

  // Signing in at an identity provider. The two are told apart on purpose: one
  // is answered in the configuration, the other by looking at the provider.
  AUTH_OIDC_NOT_CONFIGURED: 'AUTH_OIDC_NOT_CONFIGURED',
  AUTH_OIDC_PROVIDER_UNAVAILABLE: 'AUTH_OIDC_PROVIDER_UNAVAILABLE',

  // Validation (400)
  VALIDATION_EMAIL_REQUIRED: 'VALIDATION_EMAIL_REQUIRED',
  VALIDATION_PASSWORD_REQUIRED: 'VALIDATION_PASSWORD_REQUIRED',
  VALIDATION_PASSWORD_TOO_SHORT: 'VALIDATION_PASSWORD_TOO_SHORT',
  VALIDATION_PASSWORD_MISMATCH: 'VALIDATION_PASSWORD_MISMATCH',

  // Rate limiting (429)
  RATE_LIMIT_LOGIN: 'RATE_LIMIT_LOGIN',
  RATE_LIMIT_PASSWORD: 'RATE_LIMIT_PASSWORD',

  // Not Found (404)
  NOT_FOUND_USER: 'NOT_FOUND_USER',

  // Conflict (409)
  CONFLICT_USER_EXISTS: 'CONFLICT_USER_EXISTS',
  CONFLICT_PASSWORD_EXISTS: 'CONFLICT_PASSWORD_EXISTS',
  CONFLICT_SETUP_COMPLETE: 'CONFLICT_SETUP_COMPLETE',

  // Generic codes (set as defaults in AppError.js)
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
};

module.exports = { ErrorCodes };
