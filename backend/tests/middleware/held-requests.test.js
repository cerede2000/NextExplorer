import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * A request that is accepted and never answered leaves nothing behind: the
 * event loop is idle, the log is quiet, and an orchestrator declares the
 * container dead with no more to go on than anyone reading afterwards had.
 */
const logger = require('../../src/utils/logger');
const { createHeldRequestLogger, markLongPoll } = require('../../src/middleware/heldRequests');

// The real logger with its `warn` watched. What this middleware writes is the
// entire point of it, so a stand-in that never sees the real call would be
// testing the stand-in. Real timers throughout: faking the clock stops
// supertest's own sockets from progressing.
let warn;

beforeEach(() => {
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

const appHolding = (holdMs, options) => {
  const app = express();
  app.use(createHeldRequestLogger({ heldAfterMs: 20, ...options }));
  app.get('/slow', (_req, res) => {
    setTimeout(() => res.status(200).json({ ok: true }), holdMs);
  });
  app.get('/fast', (_req, res) => res.status(200).json({ ok: true }));
  return app;
};

describe('reporting a request that is held', () => {
  it('says nothing about a request that answers straight away', async () => {
    await request(appHolding(0)).get('/fast');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(warn).not.toHaveBeenCalled();
  });

  it('names the path, and says the route was never reached', async () => {
    await request(appHolding(120)).get('/slow');

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/slow', headersSent: false }),
      'Request accepted and not yet answered'
    );
  });

  // The half that tells a redirect apart from a hang: a request held for
  // eleven seconds and then answered 302 is an identity provider, not a
  // deadlock, and the status is the only thing that says which.
  it('says what it answered in the end', async () => {
    await request(appHolding(120)).get('/slow');

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/slow', statusCode: 200 }),
      'A held request finally answered'
    );
  });

  /**
   * An open editor long-polls every thirty seconds and is answered after
   * twenty-five. Reporting that is not merely noise: at ten reports it spends
   * the whole ceiling in five minutes and leaves the instrument silent for the
   * rest of the process's life — the noise would switch the thing off.
   */
  it('says nothing about a request a route means to hold', async () => {
    const app = express();
    app.use(createHeldRequestLogger({ heldAfterMs: 20 }));
    app.get('/poll', (req, res) => {
      markLongPoll(req);
      setTimeout(() => res.status(200).json({ ok: true }), 120);
    });

    await request(app).get('/poll');

    expect(warn).not.toHaveBeenCalled();
  });

  it('still reports one that nobody meant to hold', async () => {
    await request(appHolding(120)).get('/slow');

    expect(warn).toHaveBeenCalled();
  });

  // A diagnostic for a stuck server must not become the loudest thing in its
  // log: a hundred held requests are the same fact reported a hundred times.
  it('stops reporting once it has said enough', async () => {
    const app = appHolding(80, { maxReported: 2 });

    await Promise.all([
      request(app).get('/slow'),
      request(app).get('/slow'),
      request(app).get('/slow'),
      request(app).get('/slow'),
    ]);

    const held = warn.mock.calls.filter(
      ([, message]) => message === 'Request accepted and not yet answered'
    );
    expect(held).toHaveLength(2);
  });
});
