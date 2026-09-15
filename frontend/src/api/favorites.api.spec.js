import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The favorites endpoints, as the sidebar calls them. A favorite is added and
 * removed by its path but edited by its id, and the server matches the path as
 * written: a path sent with a stray slash, or an id left unencoded, leaves the
 * sidebar showing a change the server never made.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal()),
  requestJson,
}));

const api = await import('./favorites.api');

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

describe('the favorites API', () => {
  it('lists the favorites', async () => {
    await api.fetchFavorites();

    expect(call()).toEqual({ endpoint: '/api/favorites', method: 'GET', body: null });
  });

  it('adds a folder by its path, with how it should look', async () => {
    await api.addFavorite('/Projects/Q3 & Q4/', { label: 'Plans', icon: 'star', color: '#f00' });
    expect(call()).toEqual({
      endpoint: '/api/favorites',
      method: 'POST',
      body: { path: 'Projects/Q3 & Q4', label: 'Plans', icon: 'star', color: '#f00' },
    });

    await api.addFavorite('Projects');
    expect(call().body).toEqual({ path: 'Projects' });
  });

  it('edits a favorite named by its encoded id', async () => {
    await api.updateFavorite('fav 1/2', {
      label: 'Plans',
      icon: 'star',
      color: '#0f0',
      position: 3,
    });
    expect(call()).toEqual({
      endpoint: '/api/favorites/fav%201%2F2',
      method: 'PATCH',
      body: { label: 'Plans', icon: 'star', color: '#0f0', position: 3 },
    });

    await api.updateFavorite('f1', { label: 'Only the label' });
    expect(call().body).toEqual({ label: 'Only the label' });
  });

  it('reorders the favorites on their own route, not as an edit of one of them', async () => {
    await api.reorderFavorites(['f2', 'f1']);

    expect(call()).toEqual({
      endpoint: '/api/favorites/reorder',
      method: 'PATCH',
      body: { order: ['f2', 'f1'] },
    });
  });

  it('removes a favorite by its path', async () => {
    await api.removeFavorite('/Projects/Q3 & Q4/');

    expect(call()).toEqual({
      endpoint: '/api/favorites',
      method: 'DELETE',
      body: { path: 'Projects/Q3 & Q4' },
    });
  });
});
