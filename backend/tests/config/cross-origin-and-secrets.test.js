import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What another origin, and another service, are handed by default.
 *
 * With none of CORS_ORIGINS, PUBLIC_URL or INTERNAL_URL set, the server
 * reflected whatever Origin asked, with credentials. The session cookie is
 * SameSite=Lax, which keeps other sites out but not another page of the same
 * site — another port of the same host, a sibling subdomain — so any of those
 * could read an authenticated user's files. Nothing cross-origin is allowed
 * by default now.
 *
 * ONLYOFFICE, given no secret of its own, was handed the session secret — the
 * value that signs every session cookie — so whoever administers the Document
 * Server could forge anybody's session here. It is given a secret derived
 * from it instead.
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

describe('the secret ONLYOFFICE is given', () => {
  const configWith = async (env) => {
    envContext = await setupTestEnv({
      tag: 'onlyoffice-secret-',
      env: { SESSION_SECRET: 'the-session-secret', ...env },
    });
    return envContext.requireFresh('src/config/index');
  };

  it('is never the session secret', async () => {
    const config = await configWith({
      ONLYOFFICE_URL: 'http://docs.example',
      ONLYOFFICE_SECRET: '',
    });

    expect(config.onlyoffice.secret).toBeTruthy();
    expect(config.onlyoffice.secret).not.toBe('the-session-secret');
  });

  it('is the same from one start to the next, so documents open after a restart', async () => {
    const first = (await configWith({ ONLYOFFICE_SECRET: '' })).onlyoffice.secret;
    await envContext.cleanup();
    const second = (await configWith({ ONLYOFFICE_SECRET: '' })).onlyoffice.secret;

    expect(second).toBe(first);
  });

  it('is the one configured, when there is one', async () => {
    const config = await configWith({ ONLYOFFICE_SECRET: 'shared-with-docs' });

    expect(config.onlyoffice.secret).toBe('shared-with-docs');
  });

  it('is said at start to need setting, when ONLYOFFICE is used without one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await configWith({ ONLYOFFICE_URL: 'http://docs.example', ONLYOFFICE_SECRET: '' });

    expect(warn.mock.calls.some(([line]) => /ONLYOFFICE_SECRET/.test(String(line)))).toBe(true);
  });
});
