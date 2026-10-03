/**
 * The folder a route is on.
 *
 * Said once, because four places were working it out and a share says it in a
 * shape only some of them knew. `/browse/<path>` keeps the whole folder in one
 * parameter; a share's own address keeps the token apart from what follows it —
 * `/share/<token>/browse/<path>` — because the token is what decides who may see
 * any of it, and a guard should not have to pick it back out of a path.
 *
 * The folder both of them name is the same thing, and it is what the server is
 * asked for: `Docs/Reports`, or `share/<token>/Reports`.
 */

/** A wildcard parameter, which vue-router hands over as an array of segments. */
const segmentsOf = (value) =>
  Array.isArray(value) ? value.filter(Boolean).join('/') : String(value || '');

export const folderPathOfRoute = (route) => {
  const inner = segmentsOf(route?.params?.path);
  const token = typeof route?.params?.token === 'string' ? route.params.token : '';
  const whole = token ? `share/${token}${inner ? `/${inner}` : ''}` : inner;
  return whole.replace(/^\/+|\/+$/g, '');
};
