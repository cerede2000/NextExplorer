import { requestJson } from './http';

/**
 * The activity log, from the page that reads it.
 *
 * Everything is a filter and a place to carry on from: the server pages by the
 * moment of the last row rather than by an offset, so "more" is the timestamp
 * it handed back and never a page number.
 */

const fetchActivity = ({ action, user, outcome, from, to, q, before, limit } = {}) => {
  const query = new URLSearchParams();
  const add = (key, value) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  };
  add('action', action);
  add('user', user);
  add('outcome', outcome);
  add('from', from);
  add('to', to);
  add('q', q);
  add('before', before);
  add('limit', limit);

  const suffix = query.toString();
  return requestJson(`/api/activity${suffix ? `?${suffix}` : ''}`, { method: 'GET' });
};

/** Empty it. What retention would do eventually, now. */
const clearActivity = () => requestJson('/api/activity', { method: 'DELETE' });

export { clearActivity, fetchActivity };
