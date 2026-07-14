import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  sanitizeReturnTo,
  getConfiguredRequestOrigin,
  absoluteReturnTo,
} = require('../../src/utils/oidcRedirect');

const configuredOrigins = ['https://files.example.test', 'http://192.168.1.250:3017'];

const makeRequest = ({ protocol = 'https', host, forwardedHost } = {}) => ({
  protocol,
  headers: {
    ...(host ? { host } : {}),
    ...(forwardedHost ? { 'x-forwarded-host': forwardedHost } : {}),
  },
  get: (name) => (name.toLowerCase() === 'host' ? host : undefined),
});

describe('OIDC origin-aware redirects', () => {
  it('keeps only same-site return paths in OIDC state', () => {
    expect(sanitizeReturnTo('/browse/Media?sort=name')).toBe('/browse/Media?sort=name');
    expect(sanitizeReturnTo('https://attacker.example')).toBe('/browse/');
    expect(sanitizeReturnTo('//attacker.example')).toBe('/browse/');
    expect(sanitizeReturnTo('/\\attacker.example')).toBe('/browse/');
  });

  it('selects the exact configured origin used by the browser', () => {
    expect(
      getConfiguredRequestOrigin(
        makeRequest({ protocol: 'https', host: 'files.example.test' }),
        configuredOrigins
      )
    ).toBe('https://files.example.test');
    expect(
      getConfiguredRequestOrigin(
        makeRequest({ protocol: 'http', host: '192.168.1.250:3017' }),
        configuredOrigins
      )
    ).toBe('http://192.168.1.250:3017');
  });

  it('uses a configured forwarded host and rejects unknown hosts', () => {
    expect(
      getConfiguredRequestOrigin(
        makeRequest({
          protocol: 'https',
          host: 'next-explorer:3000',
          forwardedHost: 'files.example.test',
        }),
        configuredOrigins
      )
    ).toBe('https://files.example.test');
    expect(
      getConfiguredRequestOrigin(
        makeRequest({ protocol: 'https', host: 'attacker.example' }),
        configuredOrigins
      )
    ).toBeNull();
  });

  it('builds an absolute logout return URL from the selected origin', () => {
    expect(absoluteReturnTo('http://192.168.1.250:3017', '/auth/login?expired=1')).toBe(
      'http://192.168.1.250:3017/auth/login?expired=1'
    );
  });
});
