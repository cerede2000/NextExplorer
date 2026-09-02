import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Whether the reader may annotate, and whether the editor will let them.
 *
 * Two things decide it, and only one of them is obvious. `permissions.comment`
 * is the grant — ONLYOFFICE infers it from `edit` when it is missing, which is
 * why it is now written down rather than inherited. `editorConfig.mode` is the
 * one that silently wins: 'view' loads a viewer, and a viewer has no comment UI
 * however the permissions read. A comment-only reader needs `mode: 'edit'` with
 * `edit: false`, so the two must not be computed from the same boolean.
 *
 * Nothing grants comment-only yet. These tests pin the shape that will make it
 * a one-line change, and the behaviour that must not drift in the meantime.
 */

describe('what the editor is told about commenting', () => {
  let env;

  const configFor = async ({ readOnly = false, body = {} } = {}) => {
    env = await setupTestEnv({
      tag: 'onlyoffice-comment-',
      modules: [
        'src/routes/onlyoffice',
        'src/services/accessManager',
        'src/middleware/errorHandler',
      ],
      env: {
        PUBLIC_URL: 'https://files.example.com',
        ONLYOFFICE_URL: 'http://127.0.0.1:1',
        ONLYOFFICE_SECRET: 'onlyoffice-test-secret',
        ...(readOnly ? { READ_ONLY: 'true' } : {}),
      },
    });

    await fs.writeFile(path.join(env.volumeDir, 'report.docx'), Buffer.from('original'));

    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    const app = createTestApp({
      router: routes,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });

    const response = await request(app)
      .post('/api/onlyoffice/config')
      .send({ path: 'report.docx', ...body });
    expect(response.status).toBe(200);
    return response.body.config;
  };

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('states the comment permission rather than leaving it to be inferred', async () => {
    const config = await configFor();

    expect(config.document.permissions).toHaveProperty('comment');
  });

  it('lets somebody who can edit comment, in a mode that shows the UI', async () => {
    const config = await configFor();

    expect(config.document.permissions.edit).toBe(true);
    expect(config.document.permissions.comment).toBe(true);
    expect(config.editorConfig.mode).toBe('edit');
  });

  it('keeps track changes available to an editor', async () => {
    const config = await configFor();

    expect(config.document.permissions.review).toBe(true);
  });

  /**
   * `mode: 'view'` explicitly asks for a viewer, so nothing is offered — this is
   * the caller saying "just show it", not an access decision.
   */
  it('offers nothing when the caller asked for a viewer', async () => {
    const config = await configFor({ body: { mode: 'view' } });

    expect(config.document.permissions.edit).toBe(false);
    expect(config.document.permissions.comment).toBe(false);
    expect(config.editorConfig.mode).toBe('view');
  });

  /**
   * The invariant that outlives the current wiring: whatever grants commenting,
   * granting it while the mode stays 'view' ships a document nobody can comment
   * on and no error to say so.
   */
  it('never grants commenting in a mode that cannot show it', async () => {
    for (const body of [{}, { mode: 'view' }, { mode: 'edit' }]) {
      const config = await configFor({ body });
      if (config.document.permissions.comment) {
        expect(config.editorConfig.mode, JSON.stringify(body)).toBe('edit');
      }
      await env.cleanup();
      env = null;
    }
  });
});
