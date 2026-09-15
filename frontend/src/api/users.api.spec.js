import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The user administration endpoints, as the admin screens call them. Every one
 * of them names an account in the URL, so an id that is not encoded, or a call
 * sent to the neighbouring route, acts on the wrong account or does nothing: an
 * unlock sent to the delete route would remove the person it meant to let in.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal()),
  requestJson,
}));

const api = await import('./users.api');

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

describe('the users API', () => {
  it('lists every account, and the accounts a share can name', async () => {
    await api.fetchUsers();
    expect(call()).toEqual({ endpoint: '/api/users', method: 'GET', body: null });

    await api.fetchShareableUsers();
    expect(call()).toEqual({ endpoint: '/api/users/shareable', method: 'GET', body: null });
  });

  it('changes the roles of an account named by an encoded id, sending no roles rather than garbage', async () => {
    await api.updateUserRoles('user 1/2', ['admin', 'user']);
    expect(call()).toEqual({
      endpoint: '/api/users/user%201%2F2',
      method: 'PATCH',
      body: { roles: ['admin', 'user'] },
    });

    await api.updateUserRoles('u1', 'admin');
    expect(call().body).toEqual({ roles: [] });
  });

  it('updates the profile of an account', async () => {
    await api.updateUser('u#1', { displayName: 'Ann', email: 'ann@example.com' });
    expect(call()).toEqual({
      endpoint: '/api/users/u%231',
      method: 'PATCH',
      body: { displayName: 'Ann', email: 'ann@example.com' },
    });

    await api.updateUser('u1', null);
    expect(call().body).toEqual({});
  });

  it('creates an account with what the form collected, roles defaulting to none', async () => {
    await api.createUser({
      email: 'ann@example.com',
      username: 'ann',
      password: 'correct horse',
      displayName: 'Ann',
      roles: ['admin'],
    });
    expect(call()).toEqual({
      endpoint: '/api/users',
      method: 'POST',
      body: {
        email: 'ann@example.com',
        username: 'ann',
        password: 'correct horse',
        displayName: 'Ann',
        roles: ['admin'],
      },
    });

    await api.createUser({ email: 'bob@example.com', password: 'pw' });
    expect(call().body).toEqual({ email: 'bob@example.com', password: 'pw', roles: [] });

    await api.createUser({ email: 'bob@example.com', password: 'pw', roles: 'admin' });
    expect(call().body.roles).toEqual([]);
  });

  it('sets the password of an account', async () => {
    await api.adminSetUserPassword('u 1', 'new secret');

    expect(call()).toEqual({
      endpoint: '/api/users/u%201/password',
      method: 'POST',
      body: { newPassword: 'new secret' },
    });
  });

  it('unlocks an account locked by failed sign-ins, on its lock and not on the account itself', async () => {
    await api.unlockUser('u 1');

    expect(call()).toEqual({ endpoint: '/api/users/u%201/lock', method: 'DELETE', body: null });
  });

  it('deletes an account', async () => {
    await api.deleteUser('u&1');

    expect(call()).toEqual({ endpoint: '/api/users/u%261', method: 'DELETE', body: null });
  });

  it('lists the volumes of an account', async () => {
    await api.fetchUserVolumes('u 1');

    expect(call()).toEqual({ endpoint: '/api/users/u%201/volumes', method: 'GET', body: null });
  });

  it('gives an account a volume, writable unless told otherwise', async () => {
    await api.addUserVolume('u1', { label: 'Team', path: '/srv/team', accessMode: 'readonly' });
    expect(call()).toEqual({
      endpoint: '/api/users/u1/volumes',
      method: 'POST',
      body: { label: 'Team', path: '/srv/team', accessMode: 'readonly' },
    });

    await api.addUserVolume('u1', { label: 'Team', path: '/srv/team' });
    expect(call().body).toEqual({ label: 'Team', path: '/srv/team', accessMode: 'readwrite' });
  });

  it('changes and removes a volume named by both encoded ids', async () => {
    await api.updateUserVolume('u 1', 'vol/2', { label: 'Archive', accessMode: 'readonly' });
    expect(call()).toEqual({
      endpoint: '/api/users/u%201/volumes/vol%2F2',
      method: 'PATCH',
      body: { label: 'Archive', accessMode: 'readonly' },
    });

    await api.removeUserVolume('u 1', 'vol/2');
    expect(call()).toEqual({
      endpoint: '/api/users/u%201/volumes/vol%2F2',
      method: 'DELETE',
      body: null,
    });
  });

  it('browses the server directories, from the default place or an encoded path', async () => {
    await api.browseAdminDirectories();
    expect(call()).toEqual({
      endpoint: '/api/admin/browse-directories',
      method: 'GET',
      body: null,
    });

    await api.browseAdminDirectories('/srv/a b&c #1');
    expect(call().endpoint).toBe('/api/admin/browse-directories?path=%2Fsrv%2Fa%20b%26c%20%231');
  });

  it('searches the people to mention and hands back only the list', async () => {
    requestJson.mockResolvedValueOnce({ users: [{ id: 'u1' }] });
    await expect(api.searchUsersForMention('ann & bob')).resolves.toEqual([{ id: 'u1' }]);
    expect(call()).toEqual({
      endpoint: '/api/users/search?q=ann%20%26%20bob',
      method: 'GET',
      body: null,
    });

    requestJson.mockResolvedValueOnce(null);
    await expect(api.searchUsersForMention(null)).resolves.toEqual([]);
    expect(call().endpoint).toBe('/api/users/search?q=');
  });
});
