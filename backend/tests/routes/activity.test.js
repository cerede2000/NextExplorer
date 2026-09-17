import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The activity log, through the routes that fill it and the one that reads it.
 *
 * Two things are pinned here. Nothing is written until an administrator asks
 * for a log — the switch is the feature, and a log that quietly records
 * everybody on a machine one person uses is the thing this deliberately is
 * not. And what is written has to be worth reading: who, what, and whether it
 * worked, including for the sign-in that did not.
 *
 * Passwords are hashed with bcrypt at cost 12, hence the timeout.
 */

const PASSWORD = 'secret123';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const build = async (env = {}, { trustProxy } = {}) => {
  currentEnv = await setupTestEnv({
    tag: 'activity-routes-',
    env: { AUTH_ENABLED: 'true', AUTH_MODE: 'local', ...env },
  });
  const { configureSession } = currentEnv.requireFresh('src/middleware/session');
  const authMiddleware = currentEnv.requireFresh('src/middleware/authMiddleware');
  const authRoutes = currentEnv.requireFresh('src/routes/auth');
  const activityRoutes = currentEnv.requireFresh('src/routes/activity');
  const settingsRoutes = currentEnv.requireFresh('src/routes/settings');
  const { errorHandler, notFoundHandler } = currentEnv.requireFresh('src/middleware/errorHandler');

  const app = express();
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.use(cookieParser());
  configureSession(app);
  app.use(authMiddleware);
  app.use('/api/auth', authRoutes);
  app.use('/api', activityRoutes);
  app.use('/api', settingsRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app };
};

const setUpOwner = async (app) => {
  const browser = request.agent(app);
  const response = await browser
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD });
  expect(response.status).toBe(201);
  return browser;
};

/** Switch the log on the way an administrator does: through the settings. */
const turnOn = async (browser, activity = { enabled: true }) => {
  const response = await browser.patch('/api/settings').send({ activity });
  expect(response.status).toBe(200);
  return response;
};

const read = async (browser, query = '') => (await browser.get(`/api/activity${query}`)).body;

describe('the switch', { timeout: 30_000 }, () => {
  it('records nothing at all until somebody asks for a log', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await browser.post('/api/auth/logout').send({});
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });

    const body = await read(browser);

    expect(body.enabled).toBe(false);
    expect(body.events).toEqual([]);
  });

  it('is turned on through the settings, and then records', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);

    await browser.post('/api/auth/logout').send({});
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });

    const body = await read(browser);
    expect(body.enabled).toBe(true);
    // The switch being turned on is itself the first thing the log has to
    // say: who started keeping this record, and when.
    expect(body.events.map((event) => event.action)).toEqual([
      'sign-in',
      'sign-out',
      'admin.settings',
    ]);
    expect(body.events[0]).toMatchObject({ actor: 'owner', outcome: 'ok' });
    expect(JSON.parse(body.events[0].detail)).toEqual({ method: 'password' });
  });

  it('says what may be asked for, so a page can offer the list', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    expect((await read(browser)).actions).toEqual(
      expect.arrayContaining(['sign-in', 'file.download'])
    );
  });

  it('ignores a retention of no days rather than storing one, as the other sections do', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser, { enabled: true, retentionDays: 14 });

    const response = await browser.patch('/api/settings').send({ activity: { retentionDays: 0 } });

    // An emptied field is not a value somebody chose: what was stored stays.
    expect(response.status).toBe(200);
    expect(response.body.activity).toEqual({ enabled: true, retentionDays: 14 });
  });

  it('keeps the setting where the settings page can read it back', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    await turnOn(browser, { enabled: true, retentionDays: 14 });

    expect((await browser.get('/api/settings')).body.activity).toEqual({
      enabled: true,
      retentionDays: 14,
    });
  });
});

describe('what it writes down', { timeout: 30_000 }, () => {
  it('a sign-in that was refused, and the name that was tried', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);

    await request(app).post('/api/auth/login').send({ identifier: 'owner', password: 'wrong' });

    const [event] = (await read(browser, '?outcome=refused')).events;
    expect(event).toMatchObject({ action: 'sign-in', outcome: 'refused', actor: 'owner' });
    expect(event.userId).toBeNull();
  });

  it('a second factor turned on, and the account that turned it on', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);
    const { totpCode } = currentEnv.requireFresh('src/utils/totp');

    const started = await browser.post('/api/auth/totp/start').send({});
    await browser.post('/api/auth/totp/confirm').send({ code: totpCode(started.body.secret) });

    const [event] = (await read(browser, '?action=account.two-factor')).events;
    expect(event).toMatchObject({ action: 'account.two-factor', actor: 'owner' });
    expect(JSON.parse(event.detail)).toEqual({ on: true });
  });

  it('a password changed', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);

    const changed = await browser
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'another456' });
    expect(changed.status).toBe(204);

    expect((await read(browser, '?action=account.password')).events).toMatchObject([
      { actor: 'owner', action: 'account.password' },
    ]);
  });

  it('narrows to one kind, and to one stretch of time', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);
    await browser.post('/api/auth/logout').send({});
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });

    expect((await read(browser, '?action=sign-out')).events).toHaveLength(1);
    expect((await read(browser, '?from=2100-01-01T00:00:00.000Z')).events).toEqual([]);
  });

  it('gives back a page at a time, with where to carry on from', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);
    for (let round = 0; round < 3; round += 1) {
      await browser.post('/api/auth/logout').send({});
      await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });
    }

    const first = await read(browser, '?limit=2');
    expect(first.events).toHaveLength(2);
    expect(first.nextBefore).toEqual(expect.any(String));
  });
});

describe('who may read it', { timeout: 30_000 }, () => {
  const addUser = async (app) => {
    const db = await currentEnv.requireFresh('src/services/db').getDb();
    const { createLocalUser } = currentEnv.requireFresh('src/services/users');
    await createLocalUser({
      email: 'someone@example.com',
      username: 'someone',
      password: PASSWORD,
      roles: ['user'],
    });
    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ identifier: 'someone', password: PASSWORD });
    return { browser, db };
  };

  it('nobody but an administrator', async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    await turnOn(owner);
    const { browser } = await addUser(app);

    expect((await browser.get('/api/activity')).status).toBe(403);
    expect((await browser.delete('/api/activity')).status).toBe(403);
    // Nobody at all is turned away earlier still, by the middleware in front.
    expect((await request(app).get('/api/activity')).status).toBe(401);
  });

  it('and an administrator can empty it, leaving the line that says they did', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);
    await browser.post('/api/auth/logout').send({});
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });
    const before = (await read(browser)).events;
    expect(before.length).toBeGreaterThan(0);

    const cleared = await browser.delete('/api/activity');

    expect(cleared.status).toBe(200);
    expect(cleared.body.removed).toBe(before.length);
    // The history is gone, which is what was asked. What does not go with it
    // is that somebody took it away, when, and how much there was: a log that
    // can be emptied without a trace is worth less than the rows it lost.
    const after = (await read(browser)).events;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ action: 'admin.activity-clear', actor: 'owner' });
    expect(JSON.parse(after[0].detail)).toEqual({ removed: before.length });
  });

  it('empties again, and counts only what was left', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);

    await browser.delete('/api/activity');
    const second = await browser.delete('/api/activity');

    // The one line the first emptying left behind, and no more.
    expect(second.body.removed).toBe(1);
    expect((await read(browser)).events).toHaveLength(1);
  });

  it('writes nothing when the log is off, like every other kind of event', async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);
    await browser.post('/api/auth/logout').send({});
    await browser.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD });
    await turnOn(browser, { enabled: false });

    // Rows written while it was on are still there, and still go.
    const cleared = await browser.delete('/api/activity');
    expect(cleared.body.removed).toBeGreaterThan(0);

    // Off means nothing is written — including this. Anybody who can empty
    // the log can also switch it off first, so the alternative would buy a
    // trace nobody can rely on at the cost of writing into a table the
    // operator was told is inert.
    await turnOn(browser, { enabled: true });
    expect((await read(browser)).events.map((event) => event.action)).toEqual(['admin.settings']);
  });
});

/**
 * Which address a line carries.
 *
 * In a container the socket is opened by the Docker bridge, so a log that
 * writes down whoever opened the socket says `172.18.0.1` on every line — the
 * address of no one. Behind a proxy the person is named in a header, and a
 * header is worth reading exactly when the machine that sent it is one this
 * server was told to believe.
 */
describe('the address in a line', { timeout: 30_000 }, () => {
  const signIn = (app, headers = {}) =>
    request(app).post('/api/auth/login').set(headers).send({
      identifier: 'owner',
      password: PASSWORD,
    });

  it('is the person behind the proxy, once that proxy is believed', async () => {
    const { app } = await build({}, { trustProxy: 'loopback' });
    const browser = await setUpOwner(app);
    await turnOn(browser);

    await signIn(app, { 'x-forwarded-for': '192.168.1.42' });

    const [event] = (await read(browser, '?action=sign-in')).events;
    expect(event.ip).toBe('192.168.1.42');
  });

  it('reads X-Real-IP too, which is all some proxies send', async () => {
    const { app } = await build({}, { trustProxy: 'loopback' });
    const browser = await setUpOwner(app);
    await turnOn(browser);

    await signIn(app, { 'x-real-ip': '192.168.1.42' });

    expect((await read(browser, '?action=sign-in')).events[0].ip).toBe('192.168.1.42');
  });

  it('is the machine at the other end when no proxy is believed', async () => {
    // Otherwise anybody on the network chooses what the log says about them,
    // which is worse than a log that names the proxy.
    const { app } = await build();
    const browser = await setUpOwner(app);
    await turnOn(browser);

    await signIn(app, { 'x-forwarded-for': '192.168.1.42' });

    expect((await read(browser, '?action=sign-in')).events[0].ip).toBe('127.0.0.1');
  });
});
