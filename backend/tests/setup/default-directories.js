import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll } from 'vitest';

/**
 * Give a test that never chose its directories temporary ones.
 *
 * Most suites go through setupTestEnv, which sets CONFIG_DIR and CACHE_DIR.
 * A few load the configuration on their own, and fall back on /config and
 * /cache. Loading it writes there now: the session secret is generated and kept
 * in CONFIG_DIR, and operations in flight are recorded under CACHE_DIR. On a
 * developer's machine that only logs a warning; run as root — the media job's
 * container, a host — it would create a real /config/session-secret.
 *
 * A directory set by the environment the suite runs in is left alone. One this
 * file set for an earlier test file in the same worker is replaced, since that
 * file removed it when it finished.
 */

const OWNED = '__NEXTEXPLORER_TEST_DEFAULT_DIRS__';

const owned = new Set((process.env[OWNED] || '').split(path.delimiter).filter(Boolean));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextexplorer-default-dirs-'));
const assigned = {};

for (const [name, sub] of [
  ['CONFIG_DIR', 'config'],
  ['CACHE_DIR', 'cache'],
]) {
  const current = process.env[name];
  if (current && !owned.has(current)) continue;
  owned.delete(current);
  assigned[name] = path.join(root, sub);
  process.env[name] = assigned[name];
  owned.add(assigned[name]);
}
process.env[OWNED] = [...owned].join(path.delimiter);

afterAll(() => {
  for (const [name, value] of Object.entries(assigned)) {
    if (process.env[name] === value) delete process.env[name];
    owned.delete(value);
  }
  process.env[OWNED] = [...owned].join(path.delimiter);
  fs.rmSync(root, { recursive: true, force: true });
});
