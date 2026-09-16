import { describe, it, expect, vi } from 'vitest';
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

/**
 * Most codes the server sends have no entry of their own. Asking vue-i18n for
 * one it does not have printed two warnings per refusal in the console — one
 * for the reader's language, one for the fallback — and a refusal as common as
 * "outside the volume" filled it.
 */
describe('a refusal the catalogue has only a kind for', () => {
  const generic = createI18n({
    legacy: false,
    locale: 'fr',
    fallbackLocale: 'en',
    messages: {
      en: { serverErrors: { FORBIDDEN: 'Access denied' } },
      fr: { serverErrors: { FORBIDDEN: 'Accès refusé' } },
    },
  });

  const buildGeneric = () => {
    const notifications = [];
    const handle = createErrorHandler({ addNotification: (n) => notifications.push(n) }, generic);
    return { handle, notifications };
  };

  it('is headed in the reader language and keeps the server sentence underneath', () => {
    const { handle, notifications } = buildGeneric();

    const text = handle({
      code: 'FORBIDDEN',
      message: 'Resolved path is outside the configured volume root.',
      statusCode: 403,
    });

    expect(text).toBe('Accès refusé');
    expect(notifications[0].body).toContain('Resolved path is outside the configured volume root.');
  });

  it('does not make vue-i18n warn about a code it has no entry for', () => {
    const { handle } = buildGeneric();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const text = handle({ code: 'SOMETHING_ELSE', message: 'Something else went wrong.' });

    expect(text).toBe('Something else went wrong.');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps a specific entry as the whole message, with nothing added underneath', () => {
    const { handle, notifications } = build();

    handle({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials.' });

    expect(notifications[0].heading).toBe('Invalid email or password');
    expect(notifications[0].body).toBe('');
  });
});

/**
 * Where a refusal belongs.
 *
 * A toast in the corner is right for something that failed behind the screen.
 * A wrong password is not that: the screen that asked for it says so under the
 * field, and a second copy in the corner is noise. The translation is wanted
 * either way, which is why this is an option and not a separate path.
 */
describe('a refusal the screen will say itself', () => {
  it('translates it and raises nothing', () => {
    const { handle, notifications } = build();

    const heading = handle(
      { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials.' },
      { quiet: true }
    );

    expect(heading).toBe('Invalid email or password');
    expect(notifications).toHaveLength(0);
  });

  it('still raises one when nobody asked for quiet', () => {
    const { handle, notifications } = build();

    handle({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials.' });

    expect(notifications).toHaveLength(1);
  });
});
