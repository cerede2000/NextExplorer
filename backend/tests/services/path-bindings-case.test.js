import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A folder, and another whose name differs from it only by case.
 *
 * On a Linux volume `Docs` and `docs` are two folders. What the database ties
 * to a path under one of them was found with `LIKE 'Docs/%'`, which SQLite
 * matches without regard to case: deleting `Docs` dropped the favorites and
 * the share links of `docs/…`, and renaming it re-pointed them at `Papers/…`.
 * For a share that is worse than a broken link — `Papers/report.pdf` can be a
 * different file from the one that was shared.
 *
 * Asked of the services rather than through the routes, because this machine's
 * disk may not hold both folders at once, and the defect is in the query.
 */

let env;
let db;
let bindings;
let shares;

const PATHS = ['Docs', 'Docs/projet', 'Docs/sub/deep', 'docs/autre', 'Docs2/c', 'Docs.txt'];

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'path-case-' });
  db = await env.requireFresh('src/services/db').getDb();
  bindings = env.requireFresh('src/services/pathBindingsService');
  shares = env.requireFresh('src/services/sharesService');

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('alice', 'alice@example.com', 1, 'alice', 'Alice', '["user"]', ?, ?)`
  ).run(now, now);

  PATHS.forEach((folder, index) => {
    db.prepare(
      `INSERT INTO favorites (id, user_id, path, label, created_at, updated_at, position)
       VALUES (?, 'alice', ?, 'x', ?, ?, ?)`
    ).run(`fav-${index}`, folder, now, now, index);
    db.prepare(
      "INSERT INTO recent_destinations (user_id, path, used_at) VALUES ('alice', ?, ?)"
    ).run(folder, now);
    db.prepare(
      `INSERT INTO folder_preferences (user_id, path, sort_by, sort_order, view_mode, updated_at)
       VALUES ('alice', ?, 'name', 'asc', 'list', ?)`
    ).run(folder, now);
  });
});

afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

const pathsIn = (table, column = 'path') =>
  db
    .prepare(`SELECT ${column} AS value FROM ${table} ORDER BY ${column}`)
    .all()
    .map((row) => row.value);

const shareAt = (sourcePath) =>
  shares.createShare({ ownerId: 'alice', sourceSpace: 'volume', sourcePath });

const sourceOf = (share) =>
  db.prepare('SELECT source_path FROM shares WHERE id = ?').pluck().get(share.id);

describe('renaming a folder', () => {
  it('carries what pointed into it, and nothing from the folder spelt otherwise', async () => {
    await bindings.movePath('Docs', 'Papers');

    const expected = [
      'Docs.txt',
      'Docs2/c',
      'Papers',
      'Papers/projet',
      'Papers/sub/deep',
      'docs/autre',
    ];
    expect(pathsIn('favorites')).toEqual(expected);
    expect(pathsIn('recent_destinations')).toEqual(expected);
    expect(pathsIn('folder_preferences')).toEqual(expected);
  });

  it('leaves a share of the other folder on the file that was shared', async () => {
    const theirs = await shareAt('docs/report.pdf');
    const ours = await shareAt('Docs/report.pdf');

    await bindings.movePath('Docs', 'Papers');

    // Re-pointed at `Papers/report.pdf`, the link would open the file that
    // used to be `Docs/report.pdf` — not the one its owner shared.
    expect(sourceOf(theirs)).toBe('docs/report.pdf');
    expect(sourceOf(ours)).toBe('Papers/report.pdf');
  });
});

describe('deleting a folder', () => {
  it('forgets what pointed into it, and nothing from the folder spelt otherwise', async () => {
    await bindings.forgetPath('Docs', { includeChildren: true });

    const expected = ['Docs.txt', 'Docs2/c', 'docs/autre'];
    expect(pathsIn('favorites')).toEqual(expected);
    expect(pathsIn('recent_destinations')).toEqual(expected);
    expect(pathsIn('folder_preferences')).toEqual(expected);
  });

  it('keeps the share links of the other folder', async () => {
    const theirs = await shareAt('docs/report.pdf');
    const ours = await shareAt('Docs/report.pdf');

    await bindings.forgetPath('Docs', { includeChildren: true });

    expect(sourceOf(theirs)).toBe('docs/report.pdf');
    expect(sourceOf(ours)).toBeUndefined();
  });

  it('counts, and so deletes, only the shares that are inside it', async () => {
    await shareAt('Docs');
    await shareAt('Docs/report.pdf');
    await shareAt('Docs/sub/deep/plan.pdf');
    await shareAt('docs/report.pdf');
    await shareAt('Docs2/c.pdf');
    await shareAt('Docs.txt');
    const target = { sourceSpace: 'volume', sourcePath: 'Docs', includeChildren: true };
    const expected = ['Docs', 'Docs/report.pdf', 'Docs/sub/deep/plan.pdf'];

    // What the confirmation counts, and what the deletion then removes.
    const listed = await shares.getSharesForSourceTargets([target]);
    expect(listed.map((share) => share.sourcePath).sort()).toEqual(expected);
    const byTarget = await shares.getSharesBySourceTarget([target]);
    expect(
      byTarget
        .get('volume:Docs')
        .map((share) => share.sourcePath)
        .sort()
    ).toEqual(expected);
  });
});
