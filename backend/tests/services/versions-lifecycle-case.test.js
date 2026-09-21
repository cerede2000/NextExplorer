import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The histories under a folder, and under another whose name differs from it
 * only by case.
 *
 * On a Linux volume `Docs` and `docs` are two folders. The histories under one
 * of them were found with `LIKE 'Docs/%'`, which SQLite matches without regard
 * to case: moving `Docs` reassigned the histories of `docs/…` to files under
 * the new name, and deleting it for good purged them.
 *
 * The rows are written straight into the store rather than made by saving
 * files, because this machine's disk may not hold both folders at once, and the
 * defect is in the query.
 */

let env;
let db;
let store;
let lifecycle;
let zoneId;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

const HISTORIES = ['Docs', 'Docs/a.txt', 'Docs/sub/b.txt', 'docs/c.txt', 'Docs2/d.txt', 'Docs.txt'];

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'versions-case-', env: { UPLOAD_STORAGE_RESERVE: '0' } });
  store = load('src/services/versions/store');
  lifecycle = load('src/services/versions/lifecycle');
  db = await load('src/services/db').getDb();
  await fs.mkdir(volume('Projects'), { recursive: true });
  zoneId = (await load('src/services/trash/zones').ensureZone(volume('Projects'))).id;
  HISTORIES.forEach((relativePath, index) =>
    store.insertFile(db, { id: `vf-${index}`, zoneId, relativePath })
  );
});

afterEach(async () => {
  await env.cleanup();
});

const live = () =>
  db
    .prepare(
      "SELECT relative_path FROM version_files WHERE zone_id = ? AND state = 'live' ORDER BY relative_path"
    )
    .pluck()
    .all(zoneId);

describe('the histories of a folder', () => {
  it('follow it when it is renamed, and those of the folder spelt otherwise stay', async () => {
    const moved = await lifecycle.onMoved(volume('Projects', 'Docs'), volume('Projects', 'Papers'));

    expect(moved).toBe(3);
    expect(live()).toEqual([
      'Docs.txt',
      'Docs2/d.txt',
      'Papers',
      'Papers/a.txt',
      'Papers/sub/b.txt',
      'docs/c.txt',
    ]);
  });

  it('go when it is deleted for good, and those of the folder spelt otherwise stay', async () => {
    await lifecycle.onDeleted(volume('Projects', 'Docs'));

    expect(live()).toEqual(['Docs.txt', 'Docs2/d.txt', 'docs/c.txt']);
  });
});
