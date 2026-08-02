import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import realFs from 'node:fs';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Containment resolves a real path per selected item, and a bulk copy of a few
 * thousand files repeats the same parent lookups. On network storage each one
 * is a round-trip, so they are memoized — but only for the length of one
 * request: this cache feeds a security check, and a stale answer there is not
 * a stale answer anywhere.
 */

let currentEnv;

afterEach(async () => {
  vi.restoreAllMocks();
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const load = async (tag) => {
  currentEnv = await setupTestEnv({
    tag,
    modules: ['src/config/env', 'src/config/index', 'src/utils/requestContext', 'src/utils/pathUtils'],
  });
  // Load the context first: pathUtils captures this very instance when it is
  // required, and reloading it afterwards would hand the test a different
  // AsyncLocalStorage than the one the cache actually uses.
  const context = currentEnv.requireFresh('src/utils/requestContext');
  return {
    context,
    pathUtils: currentEnv.requireFresh('src/utils/pathUtils'),
    env: currentEnv,
  };
};

describe('Per-request realpath cache', () => {
  it('resolves the shared parent once instead of once per item', async () => {
    const { pathUtils, context, env } = await load('request-cache-hit-');
    await fs.mkdir(path.join(env.volumeDir, 'destination'), { recursive: true });

    const resolveTwentyTargets = () => {
      for (let i = 0; i < 20; i += 1) pathUtils.resolveVolumePath(`destination/new-${i}.txt`);
    };

    // Files a copy is about to create: each one fails to resolve and falls back
    // to its parent, which is the same directory twenty times over.
    const withoutCache = vi.spyOn(realFs, 'realpathSync');
    resolveTwentyTargets();
    const uncached = withoutCache.mock.calls.length;
    withoutCache.mockRestore();

    const withCache = vi.spyOn(realFs, 'realpathSync');
    context.runInRequestContext(resolveTwentyTargets);
    const cached = withCache.mock.calls.length;

    // 20 misses (never cached: the file may have just been created) plus one
    // lookup for the parent they share, instead of one parent lookup each.
    // The uncached run pays one extra for the volume root, which is resolved
    // once per process and held in its own cache from then on.
    expect(uncached).toBe(41);
    expect(cached).toBe(21);
  });

  it('does not carry answers over to the next request', async () => {
    const { pathUtils, context, env } = await load('request-cache-scope-');
    await fs.mkdir(path.join(env.volumeDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(env.volumeDir, 'docs', 'a.txt'), 'x');

    context.runInRequestContext(() => pathUtils.resolveVolumePath('docs/a.txt'));

    const spy = vi.spyOn(realFs, 'realpathSync');
    context.runInRequestContext(() => pathUtils.resolveVolumePath('docs/a.txt'));

    // A fresh request asks the filesystem again: between two requests the
    // directory may have become a symbolic link somewhere else.
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it('still refuses an escape when the cache is warm', async () => {
    const { pathUtils, context, env } = await load('request-cache-escape-');
    const outside = path.join(env.tmpRoot, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await fs.mkdir(path.join(env.volumeDir, 'ok'), { recursive: true });
    await fs.symlink(outside, path.join(env.volumeDir, 'escape'));

    context.runInRequestContext(() => {
      expect(pathUtils.resolveVolumePath('ok')).toContain('ok');
      expect(() => pathUtils.resolveVolumePath('escape/secret.txt')).toThrow(/outside/i);
      // And again, now that the cache holds an answer for it.
      expect(() => pathUtils.resolveVolumePath('escape/secret.txt')).toThrow(/outside/i);
    });
  });

  it('works outside a request context', async () => {
    const { pathUtils, env } = await load('request-cache-none-');
    await fs.mkdir(path.join(env.volumeDir, 'plain'), { recursive: true });

    // Startup code and background jobs run with no request around them.
    expect(pathUtils.resolveVolumePath('plain')).toContain('plain');
  });
});
