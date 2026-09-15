import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * sessions.db gives back what expired sessions leave.
 *
 * The daily cleanup deletes expired sessions, and SQLite keeps their pages
 * inside the file: a burst of logins — a script, a scan — grew it for good.
 * The store now keeps the file the way app.db is kept, rewrites one created
 * before that once, and the hourly maintenance pass hands the space back.
 */

const MB = 1024 * 1024;

let envContext;
let store;

afterEach(async () => {
  try {
    store?.close();
  } catch {
    /* already closed */
  }
  store = null;
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const pragma = (db, name) => Number(db.pragma(name, { simple: true }));

const sessionsFile = () => path.join(envContext.cacheDir, 'sessions.db');

/** Write roughly `megabytes` of sessions, then delete them: pages nothing uses. */
const leaveFreePages = (db, megabytes) => {
  const insert = db.prepare('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)');
  const rows = Math.ceil((megabytes * MB) / 4000);
  db.transaction(() => {
    for (let i = 0; i < rows; i += 1) insert.run(`sid-${i}`, 0, 'x'.repeat(4000));
  })();
  db.prepare('DELETE FROM sessions WHERE expired = 0').run();
};

const openStore = () => {
  const module = envContext.requireFresh('src/utils/sessionStore');
  store = module.localStore;
  return store;
};

describe('the session store', () => {
  it('creates its file in the mode that lets free space be handed back', async () => {
    envContext = await setupTestEnv({ tag: 'session-store-new-' });

    const { db } = openStore();

    expect(pragma(db, 'auto_vacuum')).toBe(2);
    expect(pragma(db, 'journal_size_limit')).toBe(64 * MB);
  });

  it('rewrites a file created before once, keeping the sessions in it', async () => {
    envContext = await setupTestEnv({ tag: 'session-store-legacy-' });
    fs.mkdirSync(envContext.cacheDir, { recursive: true });
    const legacy = new Database(sessionsFile());
    legacy.exec(
      'CREATE TABLE sessions (sid TEXT PRIMARY KEY, expired INTEGER NOT NULL, sess TEXT NOT NULL)'
    );
    legacy
      .prepare('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)')
      .run('still-signed-in', Date.now() + 60_000, JSON.stringify({ user: { id: 'u1' } }));
    leaveFreePages(legacy, 8);
    expect(pragma(legacy, 'auto_vacuum')).toBe(0);
    expect(pragma(legacy, 'freelist_count')).toBeGreaterThan(0);
    legacy.close();

    const { db } = openStore();

    expect(pragma(db, 'auto_vacuum')).toBe(2);
    expect(pragma(db, 'freelist_count')).toBe(0);
    expect(db.prepare('SELECT sid FROM sessions').pluck().all()).toEqual(['still-signed-in']);
  });
});

describe('the maintenance pass', () => {
  it('hands back the space expired sessions left in sessions.db', async () => {
    envContext = await setupTestEnv({ tag: 'session-store-pass-' });
    const { db } = openStore();
    leaveFreePages(db, 40);
    const freeBefore = pragma(db, 'freelist_count') * pragma(db, 'page_size');
    expect(freeBefore).toBeGreaterThan(30 * MB);
    const sizeBefore = fs.statSync(sessionsFile()).size;

    const maintenance = envContext.requireFresh('src/services/databaseMaintenance');
    const { 'sessions.db': result } = await maintenance.runPass();

    expect(result.reclaimedBytes).toBeGreaterThan(30 * MB);
    expect(pragma(db, 'freelist_count')).toBe(0);
    expect(fs.statSync(sessionsFile()).size).toBeLessThan(sizeBefore - 30 * MB);
  });

  it('creates no sessions.db of its own', async () => {
    envContext = await setupTestEnv({ tag: 'session-store-none-' });

    const maintenance = envContext.requireFresh('src/services/databaseMaintenance');
    const results = await maintenance.runPass();

    expect(results).not.toHaveProperty('sessions.db');
    expect(fs.existsSync(sessionsFile())).toBe(false);
  });
});
