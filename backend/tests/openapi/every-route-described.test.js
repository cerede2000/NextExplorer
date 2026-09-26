import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { mountedRoutes, INTEGRATIONS_CONFIGURED } from '../helpers/mounted-routes.js';

/**
 * The description against the routes the application actually mounts.
 *
 * A description written by hand drifts the day somebody adds a route and not
 * a paragraph — which is the reason the reference page it replaces had
 * `/api/healthz` in it, where the probe has always been `/healthz`. So both
 * directions are held: every route mounted is described, and every operation
 * described is a route that answers.
 *
 * Read from the routers, not from a list, with the integrations configured so
 * that their routes are mounted too.
 */

let envContext;
let routes;
let document;

beforeAll(async () => {
  envContext = await setupTestEnv({ tag: 'openapi-routes-', env: INTEGRATIONS_CONFIGURED });
  routes = mountedRoutes(envContext.requireFresh);
  document = envContext.requireFresh('src/openapi').buildOpenApi();
});

afterAll(async () => {
  await envContext?.cleanup();
});

/** `/api/shares/:id` and `/api/browse/{*splat}` in the description's spelling. */
const asTemplate = (expressPath) =>
  expressPath
    .replace(/\{\*[a-zA-Z]+\}/g, '{path}')
    .replace(/:([a-zA-Z]+)/g, '{$1}')
    .replace(/(.)\/$/, '$1');

/** Parameter names do not matter for whether two paths are the same route. */
const shape = (template) => template.replace(/\{[^}]+\}/g, '{}');

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

const describedOperations = () =>
  Object.entries(document.paths).flatMap(([template, operations]) =>
    HTTP_METHODS.filter((method) => operations[method]).map((method) => ({
      key: `${method.toUpperCase()} ${shape(template)}`,
      template,
      method: method.toUpperCase(),
      operation: operations[method],
    }))
  );

/**
 * The one route registered for every method: TUS answers creation at the
 * collection and the rest at the upload, and says so in its own protocol.
 */
const ALL_METHOD_ROUTES = {
  '/api/upload/tus{path}': [
    'POST /api/upload/tus',
    'OPTIONS /api/upload/tus',
    'HEAD /api/upload/tus/{}',
    'PATCH /api/upload/tus/{}',
    'DELETE /api/upload/tus/{}',
  ],
};

/**
 * The shares router is mounted twice, at `/api/shares` for its owner and at
 * `/api/share` for whoever holds a link; each route is described under the
 * mount it is meant for, and reachable under both.
 */
const SHARE_MOUNTS = ['/api/shares', '/api/share'];

const candidatesFor = (route) => {
  const template = asTemplate(route.path);
  if (route.method === 'ALL') return ALL_METHOD_ROUTES[template] || [`ALL ${shape(template)}`];
  if (SHARE_MOUNTS.includes(route.router)) {
    const inner = template.slice(route.router.length);
    return SHARE_MOUNTS.map(
      (mount) => `${route.method} ${shape(`${mount}${inner}`.replace(/(.)\/$/, '$1'))}`
    );
  }
  return [`${route.method} ${shape(template)}`];
};

describe('the description and the routes', () => {
  it('finds the routes to compare with', () => {
    // Said first: an empty list would satisfy both directions below.
    expect(routes.length).toBeGreaterThan(150);
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/healthz' }));
    expect(routes.some((route) => route.path.startsWith('/api/onlyoffice/'))).toBe(true);
  });

  it('describes every route the application mounts', () => {
    const described = new Set(describedOperations().map((entry) => entry.key));
    const missing = routes
      .filter((route) => !candidatesFor(route).some((candidate) => described.has(candidate)))
      .map((route) => `${route.method} ${route.path}`);

    expect(missing).toEqual([]);
  });

  it('describes nothing the application does not mount', () => {
    const mounted = new Set(routes.flatMap(candidatesFor));
    const invented = describedOperations()
      .filter((entry) => !mounted.has(entry.key))
      .map((entry) => entry.key);

    expect(invented).toEqual([]);
  });

  // `{*splat}` takes the rest of the URL, slashes and all. A generated client
  // encodes a slash in a path parameter unless told it may not, and the
  // description has to tell it.
  it('lets a path that takes the rest of the URL carry its slashes', () => {
    for (const { template, operation } of describedOperations()) {
      for (const parameter of operation.parameters || []) {
        if (parameter.in === 'path' && parameter.name === 'path' && template.endsWith('{path}')) {
          expect([template, parameter.allowReserved]).toEqual([template, true]);
        }
      }
    }
  });
});

describe('who may call what', () => {
  const routeFor = (entry) => routes.find((route) => candidatesFor(route).includes(entry.key));

  // An administrator's route is one behind `ensureAdmin`, which also refuses
  // every API token; the terminal asks the same question inside its handler.
  const ADMIN_CHECKED_INSIDE = new Set(['POST /api/terminal/session']);

  it('calls a route an administrator’s exactly where the route asks for one', () => {
    const disagreements = [];
    for (const entry of describedOperations()) {
      const route = routeFor(entry);
      const guarded =
        route.guards.includes('ensureAdmin') ||
        ADMIN_CHECKED_INSIDE.has(`${entry.method} ${entry.template}`);
      const described = entry.operation['x-access'] === 'admin';
      if (guarded !== described)
        disagreements.push(`${entry.key}: route ${guarded}, description ${described}`);
    }
    expect(disagreements).toEqual([]);
  });

  it('offers an API token exactly the operations the token gate lets one reach', () => {
    const { tokenMayReach } = envContext.requireFresh('src/middleware/apiTokenAuth');
    const disagreements = [];

    for (const entry of describedOperations()) {
      const access = entry.operation['x-access'];
      if (['public', 'share', 'shareVisitor', 'integration'].includes(access)) continue;

      const concrete = entry.template.replace(/\{[^}]+\}/g, 'x');
      const gateOpen = tokenMayReach({
        path: concrete,
        method: entry.method,
        scope: 'write',
      }).allowed;
      const describedOpen = (entry.operation.security || []).some((scheme) => 'apiToken' in scheme);
      // An administrator's route is shut to tokens by its own guard, behind
      // an open gate.
      const reachable = gateOpen && access !== 'admin';
      if (reachable !== describedOpen) {
        disagreements.push(`${entry.key}: gate ${reachable}, description ${describedOpen}`);
      }
    }

    expect(disagreements).toEqual([]);
  });
});
