import { describe, it, expect, afterEach } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

const MODULES = [
  'src/config/env',
  'src/config/index',
  'src/services/db',
  'src/services/sharesService',
  'src/services/guestSessionService',
];

let envContext;

/**
 * Changing a share's password is what an owner does when the link has leaked.
 * Guest sessions are the proof that someone typed the old password — or that
 * there was none to type — and they last a day, so leaving them in place meant
 * the change accomplished nothing until they expired on their own.
 */
const build = async () => {
  envContext = await setupTestEnv({ tag: 'share-revocation-test-', modules: MODULES });
  const shares = envContext.requireFresh('src/services/sharesService');
  const guests = envContext.requireFresh('src/services/guestSessionService');
  const dbService = envContext.requireFresh('src/services/db');
  const db = await dbService.getDb();

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('owner-1', 'owner@example.com', 1, 'owner', 'Owner', '["user"]', now, now);

  return { shares, guests, db };
};

const countSessions = (db, shareId) =>
  db.prepare('SELECT COUNT(*) AS count FROM guest_sessions WHERE share_id = ?').get(shareId).count;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('changing a share password ends the access it replaces', () => {
  const createShare = (shares, password = null) =>
    shares.createShare({
      ownerId: 'owner-1',
      sourcePath: 'Documents/Report',
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'anyone',
      password,
    });

  it('revokes the sessions when a password is added to an open share', async () => {
    const { shares, guests, db } = await build();
    const share = await createShare(shares);
    await guests.createGuestSession({ shareId: share.id });
    expect(countSessions(db, share.id)).toBe(1);

    await shares.updateShare(share.id, { password: 'newly-protected' });

    expect(countSessions(db, share.id)).toBe(0);
  });

  it('revokes the sessions when an existing password is replaced', async () => {
    const { shares, guests, db } = await build();
    const share = await createShare(shares, 'leaked-password');
    await guests.createGuestSession({ shareId: share.id });

    await shares.updateShare(share.id, { password: 'rotated-password' });

    expect(countSessions(db, share.id)).toBe(0);
  });

  // Removing a password opens the share up. Cutting off the people already
  // reading it would be a surprise, not a protection.
  it('keeps the sessions when the password is removed', async () => {
    const { shares, guests, db } = await build();
    const share = await createShare(shares, 'to-be-removed');
    await guests.createGuestSession({ shareId: share.id });

    await shares.updateShare(share.id, { password: null });

    expect(countSessions(db, share.id)).toBe(1);
  });

  // An owner renaming a share must not throw its visitors out.
  it('keeps the sessions when something else is updated', async () => {
    const { shares, guests, db } = await build();
    const share = await createShare(shares, 'unchanged');
    await guests.createGuestSession({ shareId: share.id });

    await shares.updateShare(share.id, { label: 'A better name' });

    expect(countSessions(db, share.id)).toBe(1);
  });

  // One share's rotation is not another share's problem.
  it('leaves other shares alone', async () => {
    const { shares, guests, db } = await build();
    const rotated = await createShare(shares, 'old');
    const untouched = await shares.createShare({
      ownerId: 'owner-1',
      sourcePath: 'Documents/Other',
      sourceSpace: 'volume',
      isDirectory: true,
      sharingType: 'anyone',
      password: 'other',
    });
    await guests.createGuestSession({ shareId: rotated.id });
    await guests.createGuestSession({ shareId: untouched.id });

    await shares.updateShare(rotated.id, { password: 'new' });

    expect(countSessions(db, rotated.id)).toBe(0);
    expect(countSessions(db, untouched.id)).toBe(1);
  });
});
