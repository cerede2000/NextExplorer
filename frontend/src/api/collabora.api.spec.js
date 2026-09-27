import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Collabora configuration request. The editor opens whatever the signed
 * configuration names, so the path, the mode and the version must travel in
 * the request: a version id left behind opens the current file for editing
 * where an earlier one was meant to be read.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal()),
  requestJson,
}));

const api = await import('./collabora.api');

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

describe('the Collabora API', () => {
  it('asks for the configuration of a file named by its path, for editing unless told otherwise', async () => {
    await api.fetchCollaboraConfig('/Docs/budget & plan.xlsx/');
    expect(call()).toEqual({
      endpoint: '/api/collabora/config',
      method: 'POST',
      body: { path: 'Docs/budget & plan.xlsx', mode: 'edit' },
    });

    await api.fetchCollaboraConfig('Docs/budget.xlsx', 'view');
    expect(call().body).toEqual({ path: 'Docs/budget.xlsx', mode: 'view' });
  });

  it('names an earlier version only when one is asked for', async () => {
    await api.fetchCollaboraConfig('Docs/budget.xlsx', 'view', { versionId: 'v1' });

    expect(call().body).toEqual({ path: 'Docs/budget.xlsx', mode: 'view', versionId: 'v1' });
  });

  it('refuses to ask without a path', async () => {
    await expect(api.fetchCollaboraConfig('')).rejects.toThrow('Path is required.');
    await expect(api.fetchCollaboraConfig('/')).rejects.toThrow('Path is required.');

    expect(requestJson).not.toHaveBeenCalled();
  });
});
