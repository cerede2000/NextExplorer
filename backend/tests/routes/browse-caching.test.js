import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A listing is not a document, and must not be cached as one.
 *
 * `GET /api/browse` carries what is true at that moment: which documents somebody has
 * open in an editor, what a folder weighs, whether a write would be refused. None of
 * that is worth remembering, and a proxy or a browser that remembers it serves a view
 * of a folder as it was — a file that was deleted still listed, a document shown as
 * open by somebody who closed it an hour ago.
 *
 * No header said so, and the answer to a GET with none is cacheable by default.
 */

let env;

afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

const app = () => {
  const server = express();
  server.use((req, _res, next) => {
    req.user = { id: 'admin-1', roles: ['admin'] };
    next();
  });
  server.use('/api', env.requireFresh('src/routes/browse'));
  server.use(env.requireFresh('src/middleware/errorHandler').errorHandler);
  return server;
};

describe('the answer to a listing', () => {
  it('is not to be kept by a browser or a proxy', async () => {
    env = await setupTestEnv({ tag: 'browse-caching-' });

    const response = await request(app()).get('/api/browse/');

    expect(response.status).toBe(200);
    // `private` keeps a shared proxy out of it; `no-store` keeps the browser from
    // answering the next navigation from what it already has.
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['cache-control']).toContain('private');
  });
});
