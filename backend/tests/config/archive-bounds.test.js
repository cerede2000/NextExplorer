import { describe, it, expect, afterEach } from 'vitest';

import { modulePath } from '../helpers/env-test-utils.js';

/**
 * The two bounds on browsing inside an archive.
 *
 * `archiveCacheService` reads both of them, and nothing defined either. In
 * JavaScript that is not an error, it is `undefined`, and every comparison
 * against `undefined` is false — so the guards were the wrong way round in two
 * different directions at once:
 *
 *   - `innerSize > browseMaxBytes` was never true, so no archive was ever too
 *     large to look inside. A .tar.gz of any size was decompressed whole into
 *     the cache so its listing could be shown, which is the one thing that
 *     guard exists to prevent.
 *   - `total <= cacheMaxBytes` was never true either, so the sweep never
 *     returned early and never stopped: it removed every cached copy it found,
 *     on every pass, and each archive was decompressed again from scratch the
 *     next time somebody opened it.
 *
 * Asserted against the configuration rather than the service, because that is
 * where the numbers were missing, and a service test would have passed just as
 * happily against `undefined`.
 */

const load = () => {
  delete require.cache[require.resolve(modulePath('src/config/index.js'))];
  delete require.cache[require.resolve(modulePath('src/config/env.js'))];
  return require(modulePath('src/config/index.js'));
};

const withEnv = (values, run) => {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

afterEach(() => load());

describe('the bounds on browsing inside an archive', () => {
  it('gives both of them a number, so every comparison against them means something', () => {
    const { archives } = withEnv(
      { MAX_BROWSABLE_ARCHIVE_SIZE: undefined, ARCHIVE_CACHE_MAX_SIZE: undefined },
      load
    );

    expect(Number.isFinite(archives.browseMaxBytes)).toBe(true);
    expect(Number.isFinite(archives.cacheMaxBytes)).toBe(true);
    expect(archives.browseMaxBytes).toBeGreaterThan(0);
    expect(archives.cacheMaxBytes).toBeGreaterThan(0);
  });

  /**
   * The comparisons as `archiveCacheService` writes them. Undefined passes the
   * first assertion above in no version of this — but it also has to be said
   * the way the code says it, because that is where it went wrong.
   */
  it('refuses an archive larger than the bound, and admits one under it', () => {
    const { archives } = load();

    expect(archives.browseMaxBytes + 1 > archives.browseMaxBytes).toBe(true);
    expect(1 > archives.browseMaxBytes).toBe(false);
  });

  it('lets a cache under the bound alone, and sweeps one over it', () => {
    const { archives } = load();

    expect(1 <= archives.cacheMaxBytes).toBe(true);
    expect(archives.cacheMaxBytes + 1 <= archives.cacheMaxBytes).toBe(false);
  });

  it('takes the size an administrator sets', () => {
    const { archives } = withEnv(
      { MAX_BROWSABLE_ARCHIVE_SIZE: '512MB', ARCHIVE_CACHE_MAX_SIZE: '1GB' },
      load
    );

    expect(archives.browseMaxBytes).toBe(512 * 1024 * 1024);
    expect(archives.cacheMaxBytes).toBe(1024 * 1024 * 1024);
  });

  it('falls back rather than failing the start when the value is not a size', () => {
    const { archives } = withEnv(
      { MAX_BROWSABLE_ARCHIVE_SIZE: 'as much as it takes', ARCHIVE_CACHE_MAX_SIZE: '-1' },
      load
    );

    expect(archives.browseMaxBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(archives.cacheMaxBytes).toBe(8 * 1024 * 1024 * 1024);
  });
});

/**
 * Every size an administrator can set, and the capital B.
 *
 * `5MB` is how the README writes it and how everyone writes it, and the parser
 * rejected it for the capital B alone — returning null, which every setting
 * reads as "not set" and answers with its default. Ten settings took their
 * default from a value that had been given: the upload chunk size, the search
 * and editor ceilings, the JSON body limit, the direct-upload limit, the
 * storage reserve, both archive bounds, the trash quota and the preview ceiling.
 */
describe('a size, however it is written', () => {
  const sizes = () => require(modulePath('src/utils/env.js')).parseByteSize;

  it.each([
    ['512M', 512 * 1024 * 1024],
    ['512MB', 512 * 1024 * 1024],
    ['512mb', 512 * 1024 * 1024],
    ['512 MB', 512 * 1024 * 1024],
    ['2GB', 2 * 1024 * 1024 * 1024],
    ['1k', 1024],
    ['4096', 4096],
  ])('reads %s', (written, bytes) => {
    expect(sizes()(written)).toBe(bytes);
  });

  it.each(['512Mo', 'as much as it takes', '', '5 5MB'])('refuses %s', (written) => {
    expect(sizes()(written)).toBe(null);
  });
});
