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

    const resolveTwentyTargets = async () => {
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await pathUtils.resolveVolumePath(`destination/new-${i}.txt`);
      }
    };

    // Files a copy is about to create: each one fails to resolve and falls back
    // to its parent, which is the same directory twenty times over.
    //
    // The spy is on `fs/promises`, which is what containment calls now: these
    // lookups run on every path a request touches, and on network storage each
    // synchronous one blocked the only thread the server has.
    const withoutCache = vi.spyOn(fs, 'realpath');
    await resolveTwentyTargets();
    const uncached = withoutCache.mock.calls.length;
    withoutCache.mockRestore();

    const withCache = vi.spyOn(fs, 'realpath');
    await context.runInRequestContext(resolveTwentyTargets);
    const cached = withCache.mock.calls.length;

    // 20 misses (never cached: the file may have just been created) plus one
    // lookup for the parent they share, instead of one parent lookup each.
    //
    // The volume root does not appear in either count. It is resolved once for
    // the life of the process and held in its own cache, and it is the one
    // lookup here that is still synchronous — a single call at startup rather
    // than one per path, which is why it was left alone.
    expect(uncached).toBe(40);
    expect(cached).toBe(21);
  });

  it('does not carry answers over to the next request', async () => {
    const { pathUtils, context, env } = await load('request-cache-scope-');
    await fs.mkdir(path.join(env.volumeDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(env.volumeDir, 'docs', 'a.txt'), 'x');

    await context.runInRequestContext(() => pathUtils.resolveVolumePath('docs/a.txt'));

    const spy = vi.spyOn(fs, 'realpath');
    await context.runInRequestContext(() => pathUtils.resolveVolumePath('docs/a.txt'));

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

    await context.runInRequestContext(async () => {
      expect(await pathUtils.resolveVolumePath('ok')).toContain('ok');
      await expect(pathUtils.resolveVolumePath('escape/secret.txt')).rejects.toThrow(/outside/i);
      // And again, now that the cache holds an answer for it.
      await expect(pathUtils.resolveVolumePath('escape/secret.txt')).rejects.toThrow(/outside/i);
    });
  });

  it('works outside a request context', async () => {
    const { pathUtils, env } = await load('request-cache-none-');
    await fs.mkdir(path.join(env.volumeDir, 'plain'), { recursive: true });

    // Startup code and background jobs run with no request around them.
    expect(await pathUtils.resolveVolumePath('plain')).toContain('plain');
  });
});

/**
 * The access rules are consulted for every path, so a bulk operation asked for
 * the settings thousands of times over — several queries and a JSON parse each
 * time, to re-read values that cannot change during one request.
 */
describe('Settings read once per request', () => {
  it('answers repeated callers from one read', async () => {
    const { context, env } = await load('settings-per-request-');
    const settings = env.requireFresh('src/services/settingsService');

    const reads = await context.runInRequestContext(async () => {
      const first = await settings.getSettings();
      const rest = await Promise.all(
        Array.from({ length: 49 }, () => settings.getSettings())
      );
      return [first, ...rest];
    });

    // The same object throughout: one read, shared. Counting queries would
    // prove nothing, since prepared statements are cached either way.
    reads.forEach((value) => expect(value).toBe(reads[0]));
  });

  it('reads again on the next request', async () => {
    const { context, env } = await load('settings-next-request-');
    const settings = env.requireFresh('src/services/settingsService');

    const first = await context.runInRequestContext(() => settings.getSettings());
    const second = await context.runInRequestContext(() => settings.getSettings());

    // Two requests, two reads: a change between them has to be visible.
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

/**
 * The property this conversion exists for, asserted directly.
 *
 * Containment runs on every path a request touches, and a bulk operation
 * resolves one per selected item — up to thirty-two hops each when links are
 * chased. Synchronously, on the network mount most deployments point at, every
 * one of those was a round trip during which the only thread the server has
 * served nothing: not another request, not the liveness probe, not the response
 * already half written. Nothing stops a synchronous call being reintroduced by
 * someone who has not read that paragraph, except this.
 */
describe('what containment does to the event loop', () => {
  it('resolves a path without a single synchronous filesystem call', async () => {
    const { pathUtils, context, env } = await load('containment-async-');
    await fs.mkdir(path.join(env.volumeDir, 'docs', 'deep'), { recursive: true });
    await fs.writeFile(path.join(env.volumeDir, 'docs', 'deep', 'a.txt'), 'x');

    // Resolve once first: the volume root is looked up synchronously exactly
    // once for the life of the process and then held, and that one call is
    // deliberate — a few at startup rather than one per path.
    await pathUtils.resolveVolumePath('docs/deep/a.txt');

    const realpathSync = vi.spyOn(realFs, 'realpathSync');
    const lstatSync = vi.spyOn(realFs, 'lstatSync');

    // Inside a request, which is the only place the shortcut runs — it is the
    // one that asks for an lstat, so resolving outside a request would leave
    // that call unexercised and this test asserting nothing about it.
    await context.runInRequestContext(async () => {
      await pathUtils.resolveVolumePath('docs/deep/a.txt');
      await pathUtils.resolveVolumePath('docs/deep/not-created-yet.txt');
    });

    expect(realpathSync).not.toHaveBeenCalled();
    expect(lstatSync).not.toHaveBeenCalled();
  });

  // A broken link is the only thing that reaches `readlink`: a valid one is
  // resolved by realpath and never gets there.
  it('follows a broken link asynchronously, and still refuses it', async () => {
    const { pathUtils, env } = await load('containment-async-broken-');
    await fs.symlink(path.join(env.tmpRoot, 'nowhere'), path.join(env.volumeDir, 'dead'));
    await pathUtils.resolveVolumePath('docs').catch(() => {});

    const readlinkSync = vi.spyOn(realFs, 'readlinkSync');

    await expect(pathUtils.resolveVolumePath('dead')).rejects.toThrow(/outside/i);

    expect(readlinkSync).not.toHaveBeenCalled();
  });
});
