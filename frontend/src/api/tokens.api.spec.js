import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The API token endpoints, as the settings page calls them.
 *
 * Nothing is decided here; what matters is that each action reaches the
 * endpoint that performs it. A rename sent to the revoke endpoint would take
 * somebody's automation down, and an identifier that is not escaped is a path
 * somebody else chose.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', () => ({ requestJson }));

const api = await import('./tokens.api');

const call = () => {
  const [endpoint, options] = requestJson.mock.calls.at(-1);
  return {
    endpoint,
    method: options?.method,
    body: options?.body ? JSON.parse(options.body) : null,
  };
};

beforeEach(() => {
  requestJson.mockClear();
});

describe('the API token endpoints', () => {
  it('lists them', async () => {
    await api.listApiTokens();
    expect(call()).toEqual({ endpoint: '/api/auth/tokens', method: 'GET', body: null });
  });

  it('issues one with everything the server asks for', async () => {
    await api.createApiToken({
      name: 'Backup',
      scope: 'write',
      expiresInDays: 90,
      password: 'secret123',
    });
    expect(call()).toEqual({
      endpoint: '/api/auth/tokens',
      method: 'POST',
      body: { name: 'Backup', scope: 'write', expiresInDays: 90, password: 'secret123' },
    });
  });

  it('renames one', async () => {
    await api.renameApiToken('0123456789abcdef', 'Nightly');
    expect(call()).toEqual({
      endpoint: '/api/auth/tokens/0123456789abcdef',
      method: 'PATCH',
      body: { name: 'Nightly' },
    });
  });

  it('revokes one', async () => {
    await api.revokeApiToken('0123456789abcdef');
    expect(call()).toEqual({
      endpoint: '/api/auth/tokens/0123456789abcdef',
      method: 'DELETE',
      body: null,
    });
  });

  it('never lets an identifier choose the path', async () => {
    await api.revokeApiToken('../../users/1');
    expect(call().endpoint).toBe('/api/auth/tokens/..%2F..%2Fusers%2F1');

    await api.renameApiToken('a b/c?d#e', 'x');
    expect(call().endpoint).toBe('/api/auth/tokens/a%20b%2Fc%3Fd%23e');
  });
});
