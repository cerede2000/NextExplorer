import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeHttpRequestForLog, sanitizeLogUrl } = require('../../src/utils/logSanitizer');

describe('log sanitizer', () => {
  it('redacts OIDC credentials and browser session headers', () => {
    expect(sanitizeLogUrl('/callback?code=secret-code&state=secret-state&source=oidc')).toBe(
      '/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&source=oidc'
    );

    expect(
      sanitizeHttpRequestForLog({
        url: '/callback?code=secret-code',
        headers: {
          authorization: 'Bearer token',
          cookie: 'appSession=secret',
          host: 'example.test',
        },
        query: { code: 'secret-code', source: 'oidc' },
      })
    ).toEqual({
      url: '/callback?code=%5Bredacted%5D',
      headers: { authorization: '[redacted]', cookie: '[redacted]', host: 'example.test' },
      query: { code: '[redacted]', source: 'oidc' },
    });
  });

  it('redacts the thumbnail signature', () => {
    // It unlocks that file for whoever holds it, so it does not belong in a
    // proxy or application log any more than the ONLYOFFICE backend token.
    expect(sanitizeLogUrl('/static/thumbnails/v3-abc.webp?t=1234.signature')).toBe(
      '/static/thumbnails/v3-abc.webp?t=%5Bredacted%5D'
    );
  });
});
