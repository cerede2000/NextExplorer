import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What the editor is told to draw for itself.
 *
 * These settings are the difference between an editor that behaves like part of
 * NextExplorer and one that behaves like an iframe someone dropped in. They are
 * easy to lose in a refactor of the config object and produce no error when they
 * go missing — the editor simply stops offering the control.
 */

describe('ONLYOFFICE editor customization', () => {
  let env;
  let app;

  const setup = async (filename = 'report.docx', body = {}) => {
    env = await setupTestEnv({
      tag: 'onlyoffice-customization-',
      modules: [
        'src/routes/onlyoffice',
        'src/services/accessManager',
        'src/middleware/errorHandler',
      ],
      env: {
        PUBLIC_URL: 'https://files.example.com',
        ONLYOFFICE_URL: 'http://127.0.0.1:1',
        ONLYOFFICE_SECRET: 'onlyoffice-test-secret',
      },
    });

    await fs.writeFile(path.join(env.volumeDir, filename), Buffer.from('original'));

    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    app = createTestApp({
      router: routes,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });

    const response = await request(app)
      .post('/api/onlyoffice/config')
      .send({ path: filename, ...body });
    expect(response.status).toBe(200);
    return response.body.config;
  };

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('asks the editor to draw its own close button', async () => {
    const config = await setup();

    // Without this the editor draws no close control at all, and the overlay
    // has no header — the only way out was a button laid over the toolbar.
    expect(config.editorConfig.customization.close).toEqual({ visible: true });
  });

  it('dresses the editor in the theme the client is showing', async () => {
    const dark = await setup('dark.docx', { theme: 'dark' });
    expect(dark.editorConfig.customization.uiTheme).toBe('theme-dark');

    await env.cleanup();
    env = null;

    const light = await setup('light.docx', { theme: 'light' });
    expect(light.editorConfig.customization.uiTheme).toBe('theme-light');
  });

  it('leaves the theme to the editor when the client sends nothing usable', async () => {
    // A client that predates this, or one sending something unexpected, must
    // not end up forcing a theme — the editor has a sensible default of its own.
    const config = await setup('report.docx', { theme: 'sepia' });

    expect(config.editorConfig.customization).not.toHaveProperty('uiTheme');
  });

  it('keeps the customization inside the signed token', async () => {
    const config = await setup();

    // The Document Server reads the config from the token when one is present.
    // Settings added to the object after signing are silently ignored, which
    // looks exactly like a Document Server that does not support them.
    const [, payload] = config.token.split('.');
    const signed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    expect(signed.editorConfig.customization.close).toEqual({ visible: true });
  });
});
