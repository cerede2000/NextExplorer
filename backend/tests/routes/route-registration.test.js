import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The wiring nobody looks at. A route file that stops being mounted breaks
 * nothing at startup and nothing in the tests that exercise it directly — it
 * simply stops answering, and the first report is a user saying a button does
 * nothing. Two of these mounts are conditional, which is the case worth
 * pinning: an editor that is not configured must not be reachable, and one that
 * is must be.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

/** Every path the router tree can match, flattened to strings. */
const mountedPaths = (app) => {
  const found = [];
  const walk = (stack, prefix) => {
    for (const layer of stack || []) {
      if (layer.route) {
        found.push(prefix + layer.route.path);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const segment = layer.regexp?.source
          ?.replace('^\\/', '/')
          .replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/')
          .replace(/\$$/, '');
        walk(layer.handle.stack, prefix + (segment && segment !== '/^\\/?$/i' ? segment : ''));
      }
    }
  };
  walk(app._router?.stack, '');
  return found;
};

const build = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'route-registration-', env });
  const registerRoutes = currentEnv.requireFresh('src/routes/index');
  const app = express();
  registerRoutes(app);
  return mountedPaths(app);
};

describe('every route file is reachable', () => {
  it.each([
    ['/api/auth', 'sign-in'],
    ['/api/upload', 'uploads'],
    ['/api/browse', 'browsing'],
    ['/api/volumes', 'volumes'],
    ['/api/favorites', 'favorites'],
    ['/api/settings', 'settings'],
    ['/api/search', 'search'],
    ['/api/users', 'accounts'],
    ['/api/metadata', 'details'],
    ['/api/permissions', 'permissions'],
    ['/api/thumbnails', 'thumbnails'],
    ['/api/features', 'features'],
    ['/api/shares', 'shares'],
    ['/api/folder-size', 'folder sizes'],
  ])('mounts %s, which serves %s', async (prefix) => {
    const paths = await build();

    expect(paths.some((mounted) => mounted.startsWith(prefix))).toBe(true);
  });
});

describe('the editors mount only when they are configured', () => {
  it('leaves ONLYOFFICE unmounted when no server is set', async () => {
    const paths = await build();

    expect(paths.some((mounted) => mounted.includes('onlyoffice'))).toBe(false);
  });

  it('mounts ONLYOFFICE once a server is set', async () => {
    const paths = await build({ ONLYOFFICE_URL: 'https://office.example.com' });

    expect(paths.some((mounted) => mounted.includes('onlyoffice'))).toBe(true);
  });

  it('leaves Collabora unmounted without both its URL and its secret', async () => {
    const paths = await build({ COLLABORA_URL: 'https://collabora.example.com' });

    expect(paths.some((mounted) => mounted.includes('collabora'))).toBe(false);
  });

  it('mounts Collabora once both are set', async () => {
    const paths = await build({
      COLLABORA_URL: 'https://collabora.example.com',
      COLLABORA_SECRET: 'a-secret',
    });

    expect(paths.some((mounted) => mounted.includes('collabora'))).toBe(true);
  });
});
