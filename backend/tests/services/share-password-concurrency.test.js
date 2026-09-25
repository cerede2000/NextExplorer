import { describe, it, expect, afterEach } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * bcrypt is slow on purpose — around a tenth of a second at cost 10 — and its
 * synchronous form stops Node doing anything else for that time. Checking a
 * share password is reachable without an account, rate limited per address, so
 * a handful of addresses could hold the only thread that serves everyone.
 *
 * What this pins is not the speed of one check but that the process keeps
 * running during them.
 */

let envContext;

const build = async () => {
  envContext = await setupTestEnv({ tag: 'share-password-async-' });
  const shares = envContext.requireFresh('src/services/sharesService');
  const dbService = envContext.requireFresh('src/services/db');
  const db = await dbService.getDb();

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
  ).run('owner-1', 'owner@example.com', 'owner', 'Owner', now, now);

  const share = await shares.createShare({
    ownerId: 'owner-1',
    sourcePath: 'Documents/Report',
    sourceSpace: 'volume',
    isDirectory: true,
    sharingType: 'anyone',
    password: 'the-right-one',
  });

  return { shares, share };
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('checking a share password', () => {
  it('accepts the password and refuses the others', async () => {
    const { shares, share } = await build();

    expect(await shares.verifySharePassword(share.id, 'the-right-one')).toBe(true);
    expect(await shares.verifySharePassword(share.id, 'not-it')).toBe(false);
    expect(await shares.verifySharePassword(share.id, '')).toBe(false);
  });

  // The synchronous form would run these one after another with nothing else
  // able to happen in between, and the timer below would not fire once.
  it('leaves the process able to do anything else while it works', async () => {
    const { shares, share } = await build();

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);

    try {
      const attempts = Array.from({ length: 6 }, (_, index) =>
        shares.verifySharePassword(share.id, `guess-${index}`)
      );
      const results = await Promise.all(attempts);

      expect(results.every((result) => result === false)).toBe(true);
      // Six checks at roughly a tenth of a second each leave a 5 ms timer a
      // great many chances to run — unless nothing else can run at all.
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });
});
