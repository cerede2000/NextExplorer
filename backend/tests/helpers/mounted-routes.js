/**
 * Every route the application mounts, as Express holds them.
 *
 * Read from the routers themselves rather than from a list somebody keeps, so
 * a test that compares against it compares against what a request would
 * actually reach. The integrations are mounted only where they are configured,
 * so the caller configures them before loading the routes, to see all of it.
 *
 * @param {(path: string) => any} requireFresh  the test environment's loader
 * @returns {Array<{ method: string, path: string, router: string, guards: string[] }>}
 *   `method` is upper case, or `ALL`; `path` is as Express spells it
 *   (`/api/browse/{*splat}`, `/api/shares/:id`); `router` names the mount it
 *   came through, so a router mounted twice can be recognised as one;
 *   `guards` names the functions the route runs before its handler.
 */
const mountedRoutes = (requireFresh) => {
  const routes = [];

  const walk = (prefix, router, label) => {
    for (const layer of router.stack || []) {
      if (layer.route) {
        const declared = layer.route.methods || {};
        const methods = declared._all
          ? ['ALL']
          : Object.keys(declared)
              .filter((method) => declared[method])
              .map((method) => method.toUpperCase());
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        const handlers = (layer.route.stack || []).map(
          (entry) => entry.name || entry.handle?.name || ''
        );
        const guards = handlers.slice(0, -1).filter(Boolean);
        for (const routePath of paths) {
          for (const method of methods) {
            routes.push({ method, path: `${prefix}${routePath}`, router: label, guards });
          }
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        // Mounted without a path of its own (`router.use(otherRouter)`): the
        // application never mounts a nested router under a prefix.
        walk(prefix, layer.handle, label);
      }
    }
  };

  const registerRoutes = requireFresh('src/routes');
  registerRoutes({
    use: (prefix, router) => {
      if (typeof prefix === 'string') walk(prefix, router, prefix);
    },
  });
  walk('', requireFresh('src/routes/health'), '/');

  return routes;
};

/** The same, configured so that every integration is mounted. */
const INTEGRATIONS_CONFIGURED = {
  ONLYOFFICE_URL: 'http://onlyoffice.invalid',
  ONLYOFFICE_SECRET: 'test-secret',
  COLLABORA_URL: 'http://collabora.invalid',
  COLLABORA_SECRET: 'test-secret',
};

module.exports = { mountedRoutes, INTEGRATIONS_CONFIGURED };
