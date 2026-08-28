import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const session = require('express-session');
const request = require('supertest');

const { responseEndCompat } = require('../../src/middleware/responseEndCompat');

/**
 * A store that implements touch, like the SQLite one the application uses.
 * With `resave: false` and an established session, that is what sends
 * express-session down the branch where it writes the body itself before
 * ending — the branch srvx's `res.end(callback)` breaks.
 */
const createTouchingStore = () => {
  const sessions = new Map();
  const store = new session.Store();
  store.get = (sid, cb) => setImmediate(() => cb(null, sessions.get(sid) || null));
  store.set = (sid, data, cb) =>
    setImmediate(() => {
      sessions.set(sid, JSON.parse(JSON.stringify(data)));
      cb(null);
    });
  store.destroy = (sid, cb) =>
    setImmediate(() => {
      sessions.delete(sid);
      cb(null);
    });
  store.touch = (sid, data, cb) => setImmediate(() => cb(null));
  return store;
};

/**
 * `whenSent` is what srvx awaits: @tus/server ends the response with a
 * callback and waits for it. 201 rather than 204 because Node silently drops
 * writes on a response that must not have a body — TUS answers 201 when it
 * creates an upload, which is where this bites first.
 */
const createApp = ({ withCompat }) => {
  let settle;
  const whenSent = new Promise((resolve) => {
    settle = resolve;
  });

  const app = express();
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      store: createTouchingStore(),
      cookie: { httpOnly: true, maxAge: 60_000 },
    })
  );

  app.get('/sign-in', (req, res) => {
    req.session.user = 'demo';
    res.status(204).end();
  });

  const handler = (req, res) => {
    res.writeHead(201);
    new Promise((resolve) => res.end(resolve)).then(
      () => settle({ ok: true }),
      (error) => settle({ ok: false, code: error?.code })
    );
  };

  if (withCompat) app.get('/upload/tus', responseEndCompat, handler);
  else app.get('/upload/tus', handler);

  return { app, whenSent };
};

describe('res.end compatibility for TUS responses', () => {
  it('throws into the caller without the wrapper, once a session exists', async () => {
    const { app, whenSent } = createApp({ withCompat: false });
    const agent = request.agent(app);
    await agent.get('/sign-in').expect(204);

    // The response never completes, so there is nothing to await here. In
    // production this rejection is not handled at all and the process exits.
    agent.get('/upload/tus').end(() => {});

    expect(await whenSent).toEqual({ ok: false, code: 'ERR_INVALID_ARG_TYPE' });
  });

  it('sends the response and resolves the caller with the wrapper', async () => {
    const { app, whenSent } = createApp({ withCompat: true });
    const agent = request.agent(app);
    await agent.get('/sign-in').expect(204);

    await agent.get('/upload/tus').expect(201);

    expect(await whenSent).toEqual({ ok: true });
  });

  it('still sends a body when one is given', async () => {
    const app = express();
    app.get('/echo', responseEndCompat, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
    });

    const response = await request(app).get('/echo').expect(200);
    expect(response.text).toBe('hello');
  });

  it('accepts the (chunk, encoding, callback) form', async () => {
    let called = false;
    const app = express();
    app.get('/echo', responseEndCompat, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello', 'utf8', () => {
        called = true;
      });
    });

    const response = await request(app).get('/echo').expect(200);
    expect(response.text).toBe('hello');
    await new Promise((resolve) => setImmediate(resolve));
    expect(called).toBe(true);
  });
});
