import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The version endpoints, as the panel calls them. Each action must reach the
 * endpoint that performs it, naming the file by its path: a restore sent to the
 * delete endpoint, or a version id sent without its file, would be refused at
 * best and act on the wrong thing at worst.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', () => ({
  requestJson,
  buildUrl: (endpoint) => `/base${endpoint}`,
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

const api = await import('./versions.api');

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

describe('the versions API', () => {
  it('lists the versions of a file named by its path', async () => {
    await api.getVersions('/Docs/notes & plans.md/');

    expect(call()).toEqual({
      endpoint: '/api/versions?path=Docs%2Fnotes%20%26%20plans.md',
      method: 'GET',
      body: null,
    });
  });

  it('downloads a version from a plain link, through the base the app is served under', () => {
    expect(api.getVersionDownloadUrl('Docs/notes.md', 'v 1')).toBe(
      '/base/api/versions/v%201/content?path=Docs%2Fnotes.md'
    );
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('reads the text of a version', async () => {
    await api.getVersionText('Docs/notes.md', 'v1');

    expect(call()).toEqual({
      endpoint: '/api/versions/v1/text?path=Docs%2Fnotes.md',
      method: 'GET',
      body: null,
    });
  });

  it('restores a version over its file', async () => {
    await api.restoreVersion('/Docs/notes.md', 'v1');

    expect(call()).toEqual({
      endpoint: '/api/versions/v1/restore',
      method: 'POST',
      body: { path: 'Docs/notes.md' },
    });
  });

  it('copies a version into a chosen folder', async () => {
    await api.copyVersionTo('Docs/notes.md', 'v1', '/Archive/');

    expect(call()).toEqual({
      endpoint: '/api/versions/v1/copy',
      method: 'POST',
      body: { path: 'Docs/notes.md', destination: 'Archive' },
    });
  });

  it('puts a version over another file', async () => {
    await api.replaceWithVersion('Docs/notes.md', 'v1', '/Other/draft.md');

    expect(call()).toEqual({
      endpoint: '/api/versions/v1/replace',
      method: 'POST',
      body: { path: 'Docs/notes.md', target: 'Other/draft.md' },
    });
  });

  it('names or pins a version', async () => {
    await api.updateVersion('Docs/notes.md', 'v1', { label: 'Sent', pinned: true });

    expect(call()).toEqual({
      endpoint: '/api/versions/v1',
      method: 'PATCH',
      body: { path: 'Docs/notes.md', label: 'Sent', pinned: true },
    });
  });

  it('deletes the chosen versions, or all of them only when told to', async () => {
    await api.deleteVersions('Docs/notes.md', { ids: ['v1', 'v2'] });
    expect(call()).toEqual({
      endpoint: '/api/versions/delete',
      method: 'POST',
      body: { path: 'Docs/notes.md', ids: ['v1', 'v2'] },
    });

    await api.deleteVersions('Docs/notes.md', { all: true });
    expect(call().body).toEqual({ path: 'Docs/notes.md', all: true });
  });
});
