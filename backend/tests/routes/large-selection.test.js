import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Deleting a large selection sends one path per file, and Express caps a JSON
 * body at 100 kB by default. Two thousand files is around 150 kB of paths — an
 * ordinary selection in a file manager — and the request came back as "request
 * entity too large" before anything looked at it.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const selectionOf = (count) =>
  Array.from({ length: count }, (_, i) => ({
    path: 'Photos/2024/Vacances ete/Albums',
    name: `IMG_20240715_${String(i).padStart(5, '0')}.jpeg`,
  }));

const buildApp = (env) => {
  const { uploads } = env.requireFresh('src/config/index');
  const app = express();
  app.use(express.json({ limit: uploads.maxJsonBodyBytes }));
  app.post('/echo', (req, res) => res.json({ received: req.body.items.length }));
  // Express answers 413 through the error pipeline, not the route.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type }));
  return app;
};

describe('Large selections', () => {
  it('accepts the body a 2000-file selection produces', async () => {
    const env = await setupTestEnv({
      tag: 'large-selection-',
      modules: ['src/config/env', 'src/config/index'],
    });
    currentEnv = env;

    const items = selectionOf(2000);
    const bytes = Buffer.byteLength(JSON.stringify({ items }));
    // Well past Express's 100 kB default — that is the whole point.
    expect(bytes).toBeGreaterThan(120 * 1024);

    const response = await request(buildApp(env)).post('/echo').send({ items });
    expect(response.status).toBe(200);
    expect(response.body.received).toBe(2000);
  });

  it('is configurable, and still refuses a body past the ceiling', async () => {
    const env = await setupTestEnv({
      tag: 'large-selection-limit-',
      env: { MAX_JSON_BODY_SIZE: '100kb' },
      modules: ['src/config/env', 'src/config/index'],
    });
    currentEnv = env;

    const { uploads } = env.requireFresh('src/config/index');
    expect(uploads.maxJsonBodyBytes).toBe(100 * 1024);

    // The ceiling still exists: it is a guard, not an open door.
    const response = await request(buildApp(env))
      .post('/echo')
      .send({ items: selectionOf(2000) });
    expect(response.status).toBe(413);
  });
});
