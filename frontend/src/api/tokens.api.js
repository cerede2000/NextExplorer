import { requestJson } from './http';

/**
 * API tokens, from the page that manages them.
 *
 * The value comes back once, in the reply to the call that makes one, and no
 * other call ever carries it: listing tokens afterwards answers with names and
 * dates. That is why `createApiToken` is the only one of these whose result is
 * worth holding on to — see the settings page, which shows it once and then
 * lets go of it.
 */

const listApiTokens = () => requestJson('/api/auth/tokens', { method: 'GET' });

const createApiToken = ({ name, scope, expiresInDays, password } = {}) =>
  requestJson('/api/auth/tokens', {
    method: 'POST',
    body: JSON.stringify({ name, scope, expiresInDays, password }),
  });

const renameApiToken = (id, name) =>
  requestJson(`/api/auth/tokens/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });

const revokeApiToken = (id) =>
  requestJson(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });

export { createApiToken, listApiTokens, renameApiToken, revokeApiToken };
