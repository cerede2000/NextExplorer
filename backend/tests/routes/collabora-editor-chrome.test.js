import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The way out of a Collabora document.
 *
 * The editor fills the screen, and it draws no close button unless it is asked
 * for one. So the page floated a button of its own over the editor's toolbar,
 * where it sat looking like something Collabora had not finished drawing
 * (nxzai/NextExplorer#303). Asked, the editor draws the button itself, in its
 * own toolbar, and posts `UI_Close` rather than closing anything on its own —
 * which is the arrangement ONLYOFFICE is already opened with.
 *
 * The ask is one parameter on the frame's address, read by the editor exactly
 * as `revisionhistory` is, so it is checked where that one is: on the answer
 * the page is handed, for a document opened either way.
 */

const COLLABORA_SECRET = 'collabora-chrome-secret';
const DOCUMENT = 'Projects/report.docx';

const DISCOVERY = `<wopi-discovery><net-zone name="external-https"><app name="writer">
<action default="true" ext="docx" name="edit" urlsrc="https://collabora.example.com/browser/dist/cool.html?"/>
<action ext="docx" name="view" urlsrc="https://collabora.example.com/browser/dist/cool.html?"/>
</app></net-zone></wopi-discovery>`;

let env;
let app;
let users;
let discovery;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  discovery = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/xml');
    res.end(DISCOVERY);
  });
  await new Promise((resolve) => discovery.listen(0, '127.0.0.1', resolve));
  const discoveryUrl = `http://127.0.0.1:${discovery.address().port}/hosting/discovery`;

  env = await setupTestEnv({
    tag: 'collabora-chrome-',
    env: {
      PUBLIC_URL: 'https://files.example.com',
      COLLABORA_URL: 'https://collabora.example.com',
      COLLABORA_SECRET,
      COLLABORA_DISCOVERY_URL: discoveryUrl,
    },
  });

  users = {
    alice: await load('src/services/users').createLocalUser({
      email: 'alice@example.com',
      username: 'alice',
      displayName: 'Alice',
      password: 'secret123',
      roles: ['user'],
    }),
  };

  await fs.mkdir(path.join(env.volumeDir, 'Projects'), { recursive: true });
  await fs.writeFile(path.join(env.volumeDir, 'Projects', 'report.docx'), 'a document');

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = users.alice;
    next();
  });
  app.use('/api', load('src/routes/collabora'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await new Promise((resolve) => discovery.close(resolve));
  await env.cleanup();
});

const openDocument = () => request(app).post('/api/collabora/config').send({ path: DOCUMENT });

describe('the address a document is opened at', () => {
  it('asks the editor to draw its own close button', async () => {
    const opened = await openDocument();

    expect(opened.status).toBe(200);
    expect(new URL(opened.body.urlSrc).searchParams.get('closebutton')).toBe('1');
  });

  /**
   * A document nobody may write opens through the `view` action, at a different
   * address out of discovery. The way out of it is no different.
   */
  it('asks for it on a document that opens only to be read', async () => {
    await load('src/services/settingsService').setSettings({
      access: { rules: [{ path: 'Projects', recursive: true, permissions: 'ro' }] },
    });

    const opened = await openDocument();

    expect(opened.status).toBe(200);
    expect(new URL(opened.body.urlSrc).searchParams.get('closebutton')).toBe('1');
  });
});
