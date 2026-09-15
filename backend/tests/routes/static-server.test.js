import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The single-page fallback, which every test until now skipped.
 *
 * `createApp({ skipStaticFiles: true })` is what the other suites pass, so the
 * one route only production registers had no coverage at all — and a bare `*`
 * left in it survived the Express 5 migration, was published, and crash-looped
 * the container: path-to-regexp refuses the pattern while the route is being
 * registered, so the server does not start. Seven hundred tests passed.
 *
 * A route nothing exercises is a route nothing protects. This suite builds the
 * application the way it ships.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

/** The application as it ships: static files mounted, nothing skipped. */
const buildShippedApp = async () => {
  currentEnv = await setupTestEnv({ tag: 'static-server-', env: { AUTH_ENABLED: 'false' } });

  // The frontend build lands next to the backend's source in the image.
  const publicDir = path.join(currentEnv.tmpRoot, 'public');
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Explorer</title>');
  await fs.writeFile(path.join(publicDir, 'app.js'), 'console.log("bundle");');

  const staticServer = currentEnv.requireFresh('src/utils/staticServer');
  const express = require('express');
  const app = express();

  // Mounted exactly as `createApp` mounts it, against a directory that exists.
  staticServer.configureStaticFiles(app, publicDir);
  return app;
};

/**
 * A logo is served under the name it was written under, which is its own for
 * every logo now, and a fixed name per type for one an earlier version wrote.
 * An installation whose settings still point at the fixed name has nothing to
 * migrate: that address keeps answering.
 */
describe('the custom logo', () => {
  const OWN = 'logo-0b7f7c1e-3d44-4c55-9a8e-1f2a3b4c5d6e (1).png';

  it.each([
    [
      'under a name of its own',
      OWN,
      '/static/logos/logo-0b7f7c1e-3d44-4c55-9a8e-1f2a3b4c5d6e%20(1).png',
    ],
    [
      'under the fixed name an earlier version used',
      'custom-logo.png',
      '/static/logos/custom-logo.png',
    ],
  ])('is served %s, sandboxed', async (_label, name, url) => {
    const app = await buildShippedApp();
    const logoDir = path.join(currentEnv.configDir, 'logos');
    await fs.mkdir(logoDir, { recursive: true });
    await fs.writeFile(path.join(logoDir, name), 'png bytes');

    const response = await request(app).get(url);

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('png bytes');
    expect(response.headers['content-security-policy']).toBe('sandbox');
  });

  it('is not served while it is still being written under its hidden name', async () => {
    const app = await buildShippedApp();
    const logoDir = path.join(currentEnv.configDir, 'logos');
    await fs.mkdir(logoDir, { recursive: true });
    await fs.writeFile(path.join(logoDir, '.logo-0b7f7c1e.part'), 'half');

    const response = await request(app).get('/static/logos/.logo-0b7f7c1e.part');

    expect(response.text).not.toBe('half');
  });
});

describe('the application as it ships', () => {
  /**
   * The failure this suite exists for does not produce a bad answer — it
   * produces no server. Registering the routes is the assertion.
   */
  it('registers its routes without refusing one', async () => {
    await expect(buildShippedApp()).resolves.toBeTruthy();
  });

  it('answers the address the application is opened at', async () => {
    const app = await buildShippedApp();

    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('Explorer');
  });

  it('answers a deep route the browser owns, not the server', async () => {
    const app = await buildShippedApp();

    const response = await request(app).get('/browse/Docs/holiday/2026');

    expect(response.status).toBe(200);
    expect(response.text).toContain('Explorer');
  });

  it('serves a real asset as itself rather than as the page', async () => {
    const app = await buildShippedApp();

    const response = await request(app).get('/app.js');

    expect(response.status).toBe(200);
    expect(response.text).toContain('bundle');
  });

  it('leaves the API alone', async () => {
    const app = await buildShippedApp();

    const response = await request(app).get('/api/anything');

    expect(response.status).toBe(404);
    expect(response.text).not.toContain('Explorer');
  });

  it('leaves the static asset routes alone', async () => {
    const app = await buildShippedApp();

    const response = await request(app).get('/static/thumbnails/missing.png');

    expect(response.status).toBe(404);
    expect(response.text).not.toContain('Explorer');
  });

  it('does not answer a write as though it were a page', async () => {
    const app = await buildShippedApp();

    const response = await request(app).post('/browse/Docs');

    expect(response.status).toBe(404);
  });
});
