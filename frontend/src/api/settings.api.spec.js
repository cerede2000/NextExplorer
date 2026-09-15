import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings endpoints, as the settings screens and the login page call them.
 * Branding is read before anyone signs in, on a route of its own; a change is a
 * partial patch, and sending anything but an object would leave the screen
 * reporting a save the server refused.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal()),
  requestJson,
}));

const api = await import('./settings.api');

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

describe('the settings API', () => {
  it('reads the branding on its public route, and the settings on theirs', async () => {
    await api.getBranding();
    expect(call()).toEqual({ endpoint: '/api/branding', method: 'GET', body: null });

    await api.getSettings();
    expect(call()).toEqual({ endpoint: '/api/settings', method: 'GET', body: null });
  });

  it('patches only the settings it is given, and sends an empty change rather than nothing', async () => {
    await api.patchSettings({ user: { showHiddenFiles: true } });
    expect(call()).toEqual({
      endpoint: '/api/settings',
      method: 'PATCH',
      body: { user: { showHiddenFiles: true } },
    });

    await api.patchSettings(undefined);
    expect(requestJson.mock.calls.at(-1)[1].body).toBe('{}');
  });
});
