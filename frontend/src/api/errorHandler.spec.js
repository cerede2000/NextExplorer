import { describe, it, expect } from 'vitest';
import { createI18n } from 'vue-i18n';

import { createErrorHandler } from './errorHandler';

/**
 * What a person reads when the server refuses them.
 *
 * The handler turns the server's error code into a sentence in their language,
 * and for the refusals that end on their own it says how long. The account lock
 * was the one that did not: the server sent no code the handler could
 * translate, so the English message went through as it was, and nothing said
 * whether to wait a minute or an hour.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      serverErrors: {
        AUTH_INVALID_CREDENTIALS: 'Invalid email or password',
        RATE_LIMIT_LOGIN:
          'Too many login attempts. Please wait {minutes} minute before trying again | Too many login attempts. Please wait {minutes} minutes before trying again',
        AUTH_ACCOUNT_LOCKED: 'Account is temporarily locked due to failed login attempts',
        AUTH_ACCOUNT_LOCKED_RETRY:
          'Account locked after too many failed sign-in attempts. Try again in {minutes} minute | Account locked after too many failed sign-in attempts. Try again in {minutes} minutes',
      },
    },
  },
});

const build = () => {
  const notifications = [];
  const handle = createErrorHandler({ addNotification: (n) => notifications.push(n) }, i18n);
  return { handle, notifications };
};

describe('a refusal with a code the catalogue knows', () => {
  it('is read in the catalogue, not as the server wrote it', () => {
    const { handle } = build();

    expect(handle({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials.' })).toBe(
      'Invalid email or password'
    );
  });

  it('is shown as a notification too, carrying the same words', () => {
    const { handle, notifications } = build();

    handle({ code: 'AUTH_INVALID_CREDENTIALS', message: 'x', statusCode: 401 });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: 'error', heading: 'Invalid email or password' });
  });
});

describe('a refusal with a code the catalogue does not know', () => {
  it('falls back to the message the server sent', () => {
    const { handle } = build();

    expect(handle({ code: 'SOMETHING_NEW', message: 'Something new went wrong.' })).toBe(
      'Something new went wrong.'
    );
  });
});

describe('a refusal that ends on its own', () => {
  it('says how many minutes, rounded up, for the login rate limit', () => {
    const { handle } = build();

    const text = handle({ code: 'RATE_LIMIT_LOGIN', details: { retryAfter: 90 } });

    expect(text).toBe('Too many login attempts. Please wait 2 minutes before trying again');
  });

  it('says how many minutes for a locked account', () => {
    const { handle } = build();

    const text = handle({ code: 'AUTH_ACCOUNT_LOCKED', details: { retryAfter: 600 } });

    expect(text).toBe(
      'Account locked after too many failed sign-in attempts. Try again in 10 minutes'
    );
  });

  it('uses the singular for a lock with less than a minute left', () => {
    const { handle } = build();

    const text = handle({ code: 'AUTH_ACCOUNT_LOCKED', details: { retryAfter: 20 } });

    expect(text).toBe(
      'Account locked after too many failed sign-in attempts. Try again in 1 minute'
    );
  });

  /** Without a duration there is nothing to put in the sentence that names one. */
  it('keeps the plain sentence for a lock that came without a duration', () => {
    const { handle } = build();

    const text = handle({ code: 'AUTH_ACCOUNT_LOCKED', details: {} });

    expect(text).toBe('Account is temporarily locked due to failed login attempts');
    expect(text).not.toContain('{minutes}');
  });
});
