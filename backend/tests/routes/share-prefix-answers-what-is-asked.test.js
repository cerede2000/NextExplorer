import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { mountedRoutes, INTEGRATIONS_CONFIGURED } from '../helpers/mounted-routes.js';

/**
 * Every address the reader's browser builds under a share's prefix is answered.
 *
 * The two halves of this were written apart and drifted: the browser puts a
 * request about a path inside a share under that share's prefix — one rule,
 * applied where the address is built — and the server mounts the routers that
 * answer there, one by one. A router left off that list is not a refusal and not
 * a 500, it is a 404: the Versions panel opened in a share and said nothing,
 * because `/api/share/<token>/versions` was an address nobody served. The panel's
 * own tests could not see it, because they mount the router themselves.
 *
 * So the halves are compared here. The addresses are read out of the frontend
 * rather than listed, and every call site must spell its endpoint out — a call
 * this cannot read fails rather than being passed over, or the comparison would
 * quietly shrink to whatever it managed to parse.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendSrc = path.resolve(here, '../../../frontend/src');

const SHARE_PREFIX = '/api/share/:shareToken';

/** Every `.js` and `.vue` of the frontend, except its tests. */
const sources = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.(js|vue)$/.test(entry.name) || entry.name.includes('.spec.')) return [];
    return [full];
  });

/**
 * Where the frontend builds a share-scoped address, and the endpoint it names.
 *
 * `endpoint` is null when the call does not name one as a plain string, which is
 * a failure rather than something to skip: an address assembled out of pieces
 * cannot be compared with what the server mounts.
 */
const callSites = () => {
  const found = [];
  for (const file of sources(frontendSrc)) {
    // The module that defines them is not a caller.
    if (file.endsWith(path.join('api', 'shareScope.js'))) continue;
    const source = fs.readFileSync(file, 'utf8');
    const pattern = /shareScoped(?:ForAny|ForPage)?\(\s*/g;
    let match;
    while ((match = pattern.exec(source))) {
      const after = source.slice(match.index + match[0].length);
      const literal = /^'(\/api\/[^']*)'/.exec(after);
      found.push({
        where: `${path.relative(frontendSrc, file)}:${source.slice(0, match.index).split('\n').length}`,
        endpoint: literal ? literal[1] : null,
        text: after.slice(0, 60).split('\n')[0],
      });
    }
  }
  return found;
};

let envContext;
let routes;

beforeAll(async () => {
  envContext = await setupTestEnv({ tag: 'share-prefix-asked-', env: INTEGRATIONS_CONFIGURED });
  routes = mountedRoutes(envContext.requireFresh);
});

afterAll(async () => {
  await envContext?.cleanup();
});

/**
 * The paths mounted under the share's prefix, with the prefix taken off and
 * Express's own spelling of "and everything below" taken out: `/usage/{*splat}`
 * and `/upload/tus{*splat}` both answer at the address the browser builds.
 */
const underThePrefix = () => [
  ...new Set(
    routes
      .filter((route) => route.path.startsWith(SHARE_PREFIX))
      .map((route) =>
        route.path
          .slice(SHARE_PREFIX.length)
          .replace(/\{\*[A-Za-z]+\}/g, '')
          .replace(/\/$/, '')
      )
  ),
];

/**
 * Whether something answers at an endpoint.
 *
 * `/api/usage` is asked as `/api/usage/<path>` and mounted as `/usage/{*splat}`,
 * so a route below the endpoint answers for it as surely as the endpoint itself.
 */
const isAnswered = (tail, mounted) =>
  mounted.some((route) => route === tail || route.startsWith(`${tail}/`));

describe('the addresses a share scopes', () => {
  it('are all spelled out where they are built', () => {
    const unreadable = callSites().filter((site) => !site.endpoint);

    expect(
      unreadable.map((site) => `${site.where} — shareScoped(${site.text}`),
      'every share-scoped call must name its endpoint as a plain string'
    ).toEqual([]);
  });

  it('is more than a handful, or this is reading nothing', () => {
    expect(callSites().length).toBeGreaterThan(40);
  });

  it('are every one of them answered under the prefix', () => {
    const mounted = underThePrefix();
    const sites = callSites().filter((site) => site.endpoint);

    const missing = [
      ...new Set(
        sites
          .filter((site) => !isAnswered(site.endpoint.slice('/api'.length), mounted))
          .map((site) => `${site.endpoint} (${site.where})`)
      ),
    ].sort();

    expect(missing, 'asked under the share prefix, answered by nothing').toEqual([]);
  });
});
