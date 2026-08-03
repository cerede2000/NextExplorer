/**
 * Test environment utilities for Vitest + Supertest testing.
 *
 * These utilities help with:
 * - Creating temporary directories for tests
 * - Managing environment variables
 * - Clearing module caches for fresh requires
 * - Setting up isolated test environments
 */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src') + path.sep;

/**
 * Override environment variables and return a restore function.
 * @param {Record<string, string | undefined>} values - Key-value pairs to set
 * @returns {() => void} Function to restore original values
 */
const overrideEnv = (values) => {
  const previous = {};
  Object.entries(values).forEach(([key, value]) => {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  return () => {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  };
};

/**
 * Resolve a module path relative to the repository root.
 * @param {string} relative - Relative path from repo root
 * @returns {string} Absolute path
 */
const modulePath = (relative) => path.join(REPO_ROOT, relative);

/**
 * Clear a module from Node's require cache.
 * This allows re-requiring modules with fresh state.
 * @param {string} moduleSource - Relative path to the module
 */
const clearModuleCache = (moduleSource) => {
  try {
    const resolved = require.resolve(modulePath(moduleSource));
    delete require.cache[resolved];
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }
};

/**
 * Clear multiple modules from cache.
 * @param {string[]} modules - Array of module paths to clear
 */
const clearModulesCache = (modules) => {
  modules.forEach(clearModuleCache);
};

/**
 * Drop every module of the application from the require cache.
 *
 * Most of them read the configured directories once, at load time, and keep
 * what they computed. A test that only cleared the modules it names therefore
 * ran against the *first* test's temporary volume as soon as a helper it never
 * mentioned sat in between — pathUtils, fsUtils, authorizationService have all
 * played that role. The failures were the worst kind: green in isolation, red
 * in a suite, and pointing at the assertion rather than the cause.
 *
 * Clearing the whole tree removes the guessing. It costs a reload of whatever
 * the test actually requires afterwards, which is a few milliseconds, and it
 * cannot be forgotten.
 */
const clearApplicationModules = () => {
  for (const resolved of Object.keys(require.cache)) {
    if (resolved.startsWith(SRC_ROOT)) delete require.cache[resolved];
  }
};

/**
 * Create temporary directories for test isolation.
 * @param {string} tag - Prefix for the temp directory name
 * @returns {Promise<{tmpRoot: string, configDir: string, cacheDir: string, volumeDir: string}>}
 */
const createTempDirs = async (tag = 'backend-tests-') => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), tag));
  const configDir = path.join(tmpRoot, 'config');
  const cacheDir = path.join(tmpRoot, 'cache');
  const volumeDir = path.join(tmpRoot, 'volume');
  await Promise.all([
    fs.mkdir(configDir, { recursive: true }),
    fs.mkdir(cacheDir, { recursive: true }),
    fs.mkdir(volumeDir, { recursive: true }),
  ]);
  return { tmpRoot, configDir, cacheDir, volumeDir };
};

/**
 * Set up a complete test environment with temp dirs and env overrides.
 *
 * Every application module is dropped from the require cache, so nothing
 * carries the previous test's directories over. `modules` is therefore no
 * longer needed and is kept only for callers that still pass it.
 *
 * @param {Object} options - Setup options
 * @param {string} options.tag - Prefix for temp directory
 * @param {string[]} [options.modules] - Unused; all application modules are cleared
 * @param {Record<string, string>} options.env - Additional env vars to set
 * @returns {Promise<TestEnvContext>} Context object with cleanup and helper methods
 *
 * @example
 * const env = await setupTestEnv({ tag: 'my-test-', env: { MY_VAR: 'value' } });
 *
 * const myService = env.requireFresh('src/services/myService');
 * // ... run tests ...
 *
 * await env.cleanup();
 */
const setupTestEnv = async ({ tag, modules = [], env = {} } = {}) => {
  const dirs = await createTempDirs(tag);
  const envOverrides = {
    CONFIG_DIR: dirs.configDir,
    CACHE_DIR: dirs.cacheDir,
    VOLUME_ROOT: dirs.volumeDir,
    SESSION_SECRET: 'test-secret',
    ...env,
  };
  const restoreEnv = overrideEnv(envOverrides);

  // `modules` is accepted for compatibility; clearing everything covers it.
  void modules;
  clearApplicationModules();

  return {
    ...dirs,
    envOverrides,
    /**
     * Clean up the test environment.
     * Call this in afterAll/afterEach to restore state.
     */
    cleanup: async () => {
      restoreEnv();
      clearApplicationModules();
      await fs.rm(dirs.tmpRoot, { recursive: true, force: true });
    },
    /**
     * Require a module with a fresh cache.
     * @param {string} moduleSource - Relative path to the module
     * @returns {any} The freshly required module
     */
    requireFresh: (moduleSource) => {
      clearModuleCache(moduleSource);
      return require(modulePath(moduleSource));
    },
  };
};

/**
 * Create a minimal Express app for testing a specific router.
 * This is a convenience helper for route tests.
 *
 * @param {Object} options - Configuration options
 * @param {express.Router} options.router - The router to mount
 * @param {string} options.mountPath - Path to mount the router at
 * @param {Object} options.user - Mock user object to inject into requests
 * @param {Function} options.errorHandler - Error handler middleware
 * @returns {express.Application} Configured Express app for testing
 *
 * @example
 * const app = createTestApp({
 *   router: myRouter,
 *   mountPath: '/api/items',
 *   user: { id: '1', roles: ['admin'] },
 *   errorHandler: errorMiddleware.errorHandler
 * });
 *
 * const response = await request(app).get('/api/items').expect(200);
 */
const createTestApp = ({ router, mountPath, user, errorHandler } = {}) => {
  const express = require('express');
  const app = express();
  app.use(express.json());

  // Inject mock user if provided
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }

  // Mount the router
  if (router && mountPath) {
    app.use(mountPath, router);
  }

  // Add error handler if provided
  if (errorHandler) {
    app.use(errorHandler);
  }

  return app;
};

module.exports = {
  overrideEnv,
  clearModuleCache,
  clearModulesCache,
  clearApplicationModules,
  createTempDirs,
  setupTestEnv,
  createTestApp,
  modulePath,
};
