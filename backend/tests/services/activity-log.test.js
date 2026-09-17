import { describe, it, expect, afterEach } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The activity log.
 *
 * Two promises hold this together. It is off unless somebody asked for it —
 * which means nothing is written, not that rows are hidden — and it can never
 * fail the request that produced the event: a download does not stop because a
 * log line could not be written. Both are tested here by breaking them.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'activity-', env });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const activityLog = currentEnv.requireFresh('src/services/activityLog');
  const settings = currentEnv.requireFresh('src/services/settingsService');
  return { db, activityLog, settings };
};

const on = async (extra = {}) => {
  const seeded = await seed();
  await seeded.settings.setSystemSetting('system', 'activity', { enabled: true, ...extra });
  return seeded;
};

const rows = (db) => db.prepare('SELECT * FROM activity_events ORDER BY at ASC').all();

/** A row written at a chosen moment, for the tests about time. */
const at = (db, when, action = 'file.download') =>
  db
    .prepare(
      `INSERT INTO activity_events (id, at, action, outcome, user_id, actor, target)
       VALUES (?, ?, ?, 'ok', 'u1', 'someone', 'notes.txt')`
    )
    .run(`id-${when}`, when, action);

describe('whether anything is written at all', () => {
  it('writes nothing until somebody asks for a log', async () => {
    const { db, activityLog } = await seed();

    const written = await activityLog.record({ action: 'sign-in', actor: 'someone' });

    expect(written).toBeNull();
    expect(rows(db)).toEqual([]);
    expect(await activityLog.isEnabled()).toBe(false);
  });

  it('writes when it is on', async () => {
    const { db, activityLog } = await on();

    await activityLog.record({
      action: 'sign-in',
      user: { id: 'u1', username: 'someone' },
      detail: { method: 'password' },
      req: { ip: '10.0.0.4' },
    });

    expect(rows(db)).toMatchObject([
      {
        action: 'sign-in',
        outcome: 'ok',
        user_id: 'u1',
        actor: 'someone',
        detail: '{"method":"password"}',
        ip: '10.0.0.4',
      },
    ]);
  });

  it('is on from the start when the environment says so', async () => {
    const { db, activityLog } = await seed({ ACTIVITY_ENABLED: 'true' });

    await activityLog.record({ action: 'sign-out', actor: 'someone' });

    expect(rows(db)).toHaveLength(1);
  });

  it('stops again when it is switched off', async () => {
    const { db, activityLog, settings } = await on();
    await activityLog.record({ action: 'sign-in', actor: 'someone' });

    await settings.setSystemSetting('system', 'activity', { enabled: false });
    await activityLog.record({ action: 'sign-in', actor: 'somebody else' });

    expect(rows(db)).toHaveLength(1);
  });
});

describe('what a row says', () => {
  it('names a guest as one, rather than as nobody', async () => {
    const { db, activityLog } = await on();

    await activityLog.record({ action: 'share.download', target: 'client/brief.pdf' });

    expect(rows(db)[0]).toMatchObject({
      actor: 'guest',
      user_id: null,
      target: 'client/brief.pdf',
    });
  });

  it('refuses an action nothing knows, rather than inventing a kind', async () => {
    const { db, activityLog } = await on();

    expect(await activityLog.record({ action: 'file.teleport', actor: 'someone' })).toBeNull();
    expect(rows(db)).toEqual([]);
  });

  it('reads an outcome it does not know as the ordinary one', async () => {
    const { db, activityLog } = await on();

    await activityLog.record({ action: 'sign-in', outcome: 'sideways', actor: 'someone' });

    expect(rows(db)[0].outcome).toBe('ok');
  });

  it('cuts a path far too long to be one, and says it cut it', async () => {
    const { db, activityLog } = await on();

    await activityLog.record({
      action: 'file.download',
      actor: 'someone',
      target: 'x'.repeat(4000),
    });

    const [row] = rows(db);
    expect(row.target).toHaveLength(1024);
    expect(row.target.endsWith('…')).toBe(true);
  });

  it('takes a detail that is already text', async () => {
    const { db, activityLog } = await on();

    await activityLog.record({ action: 'sign-in', actor: 'someone', detail: 'by hand' });

    expect(rows(db)[0].detail).toBe('by hand');
  });
});

describe('never failing the request it describes', () => {
  it('swallows a write that cannot happen', async () => {
    const { db, activityLog } = await on();
    // The table taken out from under it: as close to a broken database as a
    // test gets, and a download must still finish.
    db.exec('DROP TABLE activity_events');

    await expect(
      activityLog.record({ action: 'file.download', actor: 'someone' })
    ).resolves.toBeNull();
  });

  it('answers that it is off when the settings cannot be read', async () => {
    const { db, activityLog } = await on();
    db.exec('DROP TABLE system_settings');

    expect(await activityLog.isEnabled()).toBe(false);
  });
});

describe('reading it back', () => {
  const fill = async (activityLog) => {
    await activityLog.record({ action: 'sign-in', user: { id: 'u1', username: 'ada' } });
    await activityLog.record({
      action: 'file.download',
      user: { id: 'u1', username: 'ada' },
      target: 'reports/q3.pdf',
    });
    await activityLog.record({
      action: 'share.download',
      actor: 'link 9f2a',
      target: 'client/brief.pdf',
    });
    await activityLog.record({ action: 'sign-in', outcome: 'refused', actor: 'mallory' });
  };

  it('gives the newest first', async () => {
    const { activityLog } = await on();
    await fill(activityLog);

    const { events } = await activityLog.readActivity();

    expect(events).toHaveLength(4);
    expect(events[0].actor).toBe('mallory');
    expect(events.at(-1).action).toBe('sign-in');
  });

  it('narrows by action, by account, by outcome and by words', async () => {
    const { activityLog } = await on();
    await fill(activityLog);

    expect((await activityLog.readActivity({ action: 'sign-in' })).events).toHaveLength(2);
    expect((await activityLog.readActivity({ userId: 'u1' })).events).toHaveLength(2);
    expect((await activityLog.readActivity({ outcome: 'refused' })).events).toMatchObject([
      { actor: 'mallory' },
    ]);
    expect((await activityLog.readActivity({ query: 'brief' })).events).toMatchObject([
      { target: 'client/brief.pdf' },
    ]);
    expect((await activityLog.readActivity({ query: 'ada' })).events).toHaveLength(2);
  });

  it('ignores a filter that names nothing it knows', async () => {
    const { activityLog } = await on();
    await fill(activityLog);

    expect((await activityLog.readActivity({ action: 'file.teleport' })).events).toHaveLength(4);
  });

  it('pages from the moment of the last row, rather than by counting', async () => {
    const { db, activityLog } = await on();
    for (const day of ['01', '02', '03', '04', '05']) at(db, `2026-09-${day}T10:00:00.000Z`);

    const first = await activityLog.readActivity({ limit: 2 });
    expect(first.events.map((event) => event.at)).toEqual([
      '2026-09-05T10:00:00.000Z',
      '2026-09-04T10:00:00.000Z',
    ]);
    expect(first.nextBefore).toBe('2026-09-04T10:00:00.000Z');

    const second = await activityLog.readActivity({ limit: 2, before: first.nextBefore });
    expect(second.events.map((event) => event.at)).toEqual([
      '2026-09-03T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
    ]);

    const last = await activityLog.readActivity({ limit: 2, before: second.nextBefore });
    expect(last.events).toHaveLength(1);
    expect(last.nextBefore).toBeNull();
  });

  it('narrows to a stretch of time', async () => {
    const { db, activityLog } = await on();
    for (const day of ['01', '02', '03']) at(db, `2026-09-${day}T10:00:00.000Z`);

    const { events } = await activityLog.readActivity({
      from: '2026-09-02T00:00:00.000Z',
      to: '2026-09-02T23:59:59.000Z',
    });

    expect(events).toHaveLength(1);
    expect(events[0].at).toBe('2026-09-02T10:00:00.000Z');
  });

  it('will not hand over more than it is willing to read out', async () => {
    const { db, activityLog } = await on();
    // More rows than the cap, so the cap is the thing being measured rather
    // than how many rows happen to exist.
    const many = activityLog.MAX_LIMIT + 10;
    for (let index = 0; index < many; index += 1) {
      at(db, new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + index * 1000).toISOString());
    }

    expect((await activityLog.readActivity({ limit: 100000 })).events).toHaveLength(
      activityLog.MAX_LIMIT
    );
    // A negative limit is no limit at all in SQL; here it is one row.
    expect((await activityLog.readActivity({ limit: -5 })).events).toHaveLength(1);
    expect((await activityLog.readActivity({ limit: 0 })).events).toHaveLength(
      activityLog.DEFAULT_LIMIT
    );
  });
});

describe('forgetting', () => {
  it('drops what is past the retention and keeps the rest', async () => {
    const { db, activityLog } = await on({ retentionDays: 30 });
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    at(db, old);
    at(db, recent);

    expect(await activityLog.sweepActivity()).toBe(1);
    expect(rows(db).map((row) => row.at)).toEqual([recent]);
  });

  it('sweeps even when the log has been switched off', async () => {
    const { db, activityLog, settings } = await on({ retentionDays: 1 });
    at(db, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    await settings.setSystemSetting('system', 'activity', { enabled: false, retentionDays: 1 });

    expect(await activityLog.sweepActivity()).toBe(1);
    expect(rows(db)).toEqual([]);
  });

  it('empties the whole thing when an administrator asks', async () => {
    const { activityLog } = await on();
    await activityLog.record({ action: 'sign-in', actor: 'someone' });
    await activityLog.record({ action: 'sign-out', actor: 'someone' });

    expect(await activityLog.clearActivity()).toBe(2);
    expect(await activityLog.countActivity()).toBe(0);
  });
});
