import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What another origin is handed by default.
 *
 * With none of CORS_ORIGINS, PUBLIC_URL or INTERNAL_URL set, the server
 * reflected whatever Origin asked, with credentials. The session cookie is
 * SameSite=Lax, which keeps other sites out but not another page of the same
 * site — another port of the same host, a sibling subdomain — so any of those
 * could read an authenticated user's files. Nothing cross-origin is allowed
 * by default now.
 */

let envContext;

afterEach(async () => {
  vi.restoreAllMocks();
  await envContext?.cleanup();
  envContext = null;
});

const NOTHING = {
  PUBLIC_URL: '',
  INTERNAL_URL: '',
  CORS_ORIGINS: '',
  CORS_ORIGIN: '',
  ALLOWED_ORIGINS: '',
};

const appWith = async (env) => {
  envContext = await setupTestEnv({ tag: 'cross-origin-', env: { ...NOTHING, ...env } });
  const { configureCors } = envContext.requireFresh('src/middleware/cors');
  const app = express();
  configureCors(app);
  app.get('/api/probe', (_req, res) => res.json({ ok: true }));
  return app;
};

const allowedOriginFor = async (app, origin) =>
  (await request(app).get('/api/probe').set('Origin', origin)).headers[
    'access-control-allow-origin'
  ];

describe('a request from another origin', () => {
  it('is not answered for it when nothing is configured', async () => {
    const app = await appWith({});

    expect(await allowedOriginFor(app, 'http://192.168.1.10:8080')).toBeUndefined();
    expect(await allowedOriginFor(app, 'https://elsewhere.example')).toBeUndefined();
  });

  it('is answered for the public address, and only for it', async () => {
    const app = await appWith({ PUBLIC_URL: 'https://files.example.com' });

    expect(await allowedOriginFor(app, 'https://files.example.com')).toBe(
      'https://files.example.com'
    );
    expect(await allowedOriginFor(app, 'https://elsewhere.example')).toBeUndefined();
  });

  it('is answered for anything only when that is asked for by name', async () => {
    const app = await appWith({ CORS_ORIGINS: '*' });

    expect(await allowedOriginFor(app, 'https://elsewhere.example')).toBe(
      'https://elsewhere.example'
    );
  });

  // The control: a same-origin request carries no Origin and is served as ever.
  it('does not stand in the way of the page talking to its own server', async () => {
    const app = await appWith({});

    const response = await request(app).get('/api/probe');
    expect(response.status).toBe(200);
  });
});
