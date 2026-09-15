import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What early releases left in the cache directory.
 *
 * An installation that started on 1.1.7 or earlier kept its database in /cache;
 * the move to /config that 1.1.8 made was removed in 2.0.3, so one that skipped
 * the releases in between comes up on an empty app.db with its accounts unread
 * in /cache. Nothing said so. Now the start does — and moves nothing, since
 * which file holds what matters cannot be told from here.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const setup = async () => {
  envContext = await setupTestEnv({ tag: 'legacy-cache-' });
  const check = envContext.requireFresh('src/services/legacyCacheCheck');
  const log = { warn: vi.fn(), info: vi.fn() };
  const report = () =>
    check.reportLegacyCache({
      cacheDir: envContext.cacheDir,
      configDir: envContext.configDir,
      log,
    });
  return { check, log, report, cache: envContext.cacheDir, config: envContext.configDir };
};

describe('an app.db left in the cache directory', () => {
  it('is reported as a warning naming both files, and left where it is', async () => {
    const { log, report, cache, config } = await setup();
    fs.writeFileSync(path.join(cache, 'app.db'), 'SQLite format 3\0 with the old accounts');

    const findings = report();

    expect(findings).toEqual([expect.objectContaining({ name: 'app.db', kind: 'database' })]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      legacyDatabase: path.join(cache, 'app.db'),
      databaseInUse: path.join(config, 'app.db'),
    });
    expect(fs.existsSync(path.join(cache, 'app.db'))).toBe(true);
  });
});

describe('links left in the cache directory', () => {
  it('are mentioned as unused, not warned about, and not followed', async () => {
    const { log, report, cache, config } = await setup();
    fs.writeFileSync(path.join(config, 'app-config.json'), '{}');
    fs.symlinkSync(path.join(config, 'app.db'), path.join(cache, 'app.db'));
    fs.symlinkSync(path.join(config, 'app-config.json'), path.join(cache, 'app-config.json'));
    fs.symlinkSync(path.join(config, 'extensions'), path.join(cache, 'extensions'));

    const findings = report();

    expect(findings.map((finding) => [finding.name, finding.kind])).toEqual([
      ['app.db', 'link'],
      ['app-config.json', 'link'],
      ['extensions', 'link'],
    ]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0].links).toHaveLength(3);
  });
});

describe('a cache directory with nothing from early releases', () => {
  it('says nothing', async () => {
    const { log, report, cache } = await setup();
    fs.mkdirSync(path.join(cache, 'thumbnails'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'index.db'), 'SQLite format 3\0');

    expect(report()).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
});
