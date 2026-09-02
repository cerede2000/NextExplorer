import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What `req.body` is when nobody sent one.
 *
 * Express 4 left an empty object; Express 5 leaves it undefined, and this
 * application was written against the empty object. A route destructuring
 * `const { path, mode } = req.body` does not merely misbehave against a request
 * with no content-type header — it throws a TypeError and answers 500 to
 * something whose only fault is a missing header, which is exactly what a curl
 * one-liner sends.
 *
 * Every other suite sends JSON, so none of them can see this. This one
 * deliberately does not, and it goes through the real application so that the
 * middleware order is the one that ships.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const buildApp = async () => {
  // Authentication off, so the request arrives as an administrator and reaches
  // the line that destructures the body — with auth on it is refused above it,
  // and the test proves nothing.
  currentEnv = await setupTestEnv({ tag: 'body-shape-', env: { AUTH_ENABLED: 'false' } });
  const { createApp } = currentEnv.requireFresh('src/app');
  return createApp({ skipBootstrap: true });
};

/** The two parsers and the normaliser, in the order `createApp` mounts them. */
const parsersOnly = () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });
  return app;
};

describe('a request that carries no body', () => {
  it('reaches a route that destructures it, and is answered rather than crashing', async () => {
    const app = await buildApp();

    // No `.send()`, so no content-type: `express.json` does not run, and the
    // chmod route destructures `req.body` on the very first line.
    const response = await request(app).post('/api/permissions/chmod');

    expect(response.status).not.toBe(500);
  });

  it('is refused for the reason a caller can act on', async () => {
    const app = await buildApp();

    const response = await request(app).post('/api/permissions/chmod');

    // The route's own validation answers: a path is required.
    expect(response.status).toBe(400);
  });
});

describe('the normaliser itself', () => {
  it('leaves an empty object where the parsers left nothing', async () => {
    const app = parsersOnly();
    app.post('/probe', (req, res) => {
      res.json({ type: req.body === undefined ? 'undefined' : typeof req.body });
    });

    const response = await request(app).post('/probe');

    expect(response.body.type).toBe('object');
  });

  it('lets a route ask whether a field is present without throwing', async () => {
    const app = parsersOnly();
    app.patch('/probe', (req, res) => res.json({ present: 'accessMode' in req.body }));

    const response = await request(app).patch('/probe');

    expect(response.status).toBe(200);
    expect(response.body.present).toBe(false);
  });

  it('does not touch a body that was parsed', async () => {
    const app = parsersOnly();
    app.post('/probe', (req, res) => res.json({ got: req.body.value }));

    const response = await request(app).post('/probe').send({ value: 'kept' });

    expect(response.body.got).toBe('kept');
  });
});
