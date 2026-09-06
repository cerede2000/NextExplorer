import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The endpoint Document Server fetches a document from.
 *
 * It is exempt from authentication — the authentication middleware lets
 * `/api/onlyoffice/file` through, because the caller is a separate server with
 * no session of ours — so what stands in its place is all that decides which
 * file goes out.
 *
 * That deserved checking rather than assuming, because the token the editor
 * config hands to the browser is signed with the same secret and says nothing
 * about which file it is for. It turns out not to be enough on its own: with no
 * backend context, resolution runs with no user and is refused. The first test
 * below is that fact, pinned, because it is the one holding the door shut.
 */

let currentEnv;

const setup = async () => {
  currentEnv = await setupTestEnv({
    tag: 'onlyoffice-file-',
    env: {
      ONLYOFFICE_URL: 'https://ds.example.com',
      ONLYOFFICE_SECRET: 'shared-ds-secret',
    },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/onlyoffice',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/utils/pathUtils',
    ],
  });

  const routes = currentEnv.requireFresh('src/routes/onlyoffice');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const { onlyoffice } = currentEnv.requireFresh('src/config/index');

  await fs.mkdir(path.join(currentEnv.volumeDir, 'Private'), { recursive: true });
  const secretFile = path.join(currentEnv.volumeDir, 'Private', 'salaries.xlsx');
  const ordinaryFile = path.join(currentEnv.volumeDir, 'report.docx');
  await fs.writeFile(secretFile, 'CONFIDENTIAL');
  await fs.writeFile(ordinaryFile, 'the report');

  // No user: the route is reached without a session, as Document Server does.
  const app = express();
  app.use('/api', routes);
  app.use(errorHandler);

  /** The shape of token the editor config hands to the browser. */
  const dsToken = (secret = onlyoffice.secret) =>
    jwt.sign({ document: { key: 'anything' } }, secret, { algorithm: 'HS256' });

  /** The one that actually names a file, and is what authorises the fetch. */
  const backendToken = (claims = {}, secret = onlyoffice.secret) =>
    jwt.sign(
      { typ: 'nextexplorer-backend', absolutePath: ordinaryFile, ...claims },
      secret,
      { algorithm: 'HS256' }
    );

  return { app, secretFile, ordinaryFile, dsToken, backendToken };
};

/**
 * A document is served with its own content type, and supertest will not buffer
 * a body it has no parser for — the response arrives with an empty `text` and a
 * green status, which is a test agreeing with nothing.
 */
const collectBody = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
};

const fetchFile = (app, { query = {}, token } = {}) => {
  const call = request(app).get('/api/onlyoffice/file').query(query).buffer(true).parse(collectBody);
  if (token) call.set('Authorization', `Bearer ${token}`);
  return call;
};

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

describe('a request with nothing but a signed token', () => {
  it('is refused without one at all', async () => {
    const { app } = await setup();

    expect((await fetchFile(app, { query: { path: 'report.docx' } })).status).toBe(401);
  });

  /**
   * And says which of the two it was.
   *
   * Both refusals answer 401, so a test that reads only the status cannot tell
   * the absent token from the wrong one — removing the check for the first
   * changes nothing it can see. The distinction is worth keeping: somebody
   * wiring up a Document Server needs to know whether their token never
   * arrived or arrived wrong.
   */
  it('says the token was missing rather than wrong', async () => {
    const { app } = await setup();

    const response = await fetchFile(app, { query: { path: 'report.docx' } });

    // The parser above returns every body as text, errors included.
    expect(String(response.body)).toMatch(/missing token/i);
  });

  it('says the token was wrong when it is', async () => {
    const { app, dsToken } = await setup();

    const response = await fetchFile(app, {
      query: { path: 'report.docx' },
      token: dsToken('not-the-secret'),
    });

    expect(String(response.body)).toMatch(/invalid token/i);
  });

  it('is refused when the token was signed with another secret', async () => {
    const { app, dsToken } = await setup();

    const response = await fetchFile(app, {
      query: { path: 'report.docx' },
      token: dsToken('not-the-secret'),
    });

    expect(response.status).toBe(401);
  });

  /**
   * The door this holds shut. A signed token proves the caller shares the
   * secret with Document Server — and the editor config hands one to every
   * browser that opens a document. It says nothing about which file, so on its
   * own it resolves with no user behind it and is refused.
   */
  it('is refused when the token names no file', async () => {
    const { app, dsToken } = await setup();

    const response = await fetchFile(app, {
      query: { path: 'Private/salaries.xlsx' },
      token: dsToken(),
    });

    expect(response.status).toBe(403);
  });

  it('sends nothing of the file it refused', async () => {
    const { app, dsToken } = await setup();

    const response = await fetchFile(app, {
      query: { path: 'Private/salaries.xlsx' },
      token: dsToken(),
    });

    expect(String(response.body || '')).not.toContain('CONFIDENTIAL');
  });

  it('is refused with no path to go on', async () => {
    const { app, dsToken } = await setup();

    expect((await fetchFile(app, { token: dsToken() })).status).toBe(400);
  });
});

describe('a request carrying the token that names a file', () => {
  it('is answered with that file', async () => {
    const { app, dsToken, backendToken } = await setup();

    const response = await fetchFile(app, {
      query: { path: 'report.docx', backend: backendToken() },
      token: dsToken(),
    });

    expect(response.status).toBe(200);
    expect(String(response.body || '')).toBe('the report');
  });

  /**
   * The token decides, not the query. Otherwise the path beside it would be a
   * way to ask for something else while carrying an authorisation for this.
   */
  it('ignores a different file named in the query', async () => {
    const { app, dsToken, backendToken } = await setup();

    const response = await fetchFile(app, {
      query: { path: 'Private/salaries.xlsx', backend: backendToken() },
      token: dsToken(),
    });

    expect(String(response.body || '')).toBe('the report');
    expect(String(response.body || '')).not.toContain('CONFIDENTIAL');
  });

  it('falls back to being refused when the token declares another kind', async () => {
    const { app, secretFile, dsToken, backendToken } = await setup();

    const response = await fetchFile(app, {
      query: {
        path: 'Private/salaries.xlsx',
        backend: backendToken({ typ: 'something-else', absolutePath: secretFile }),
      },
      token: dsToken(),
    });

    expect(response.status).toBe(403);
  });

  it('falls back to being refused when it was signed with another secret', async () => {
    const { app, secretFile, dsToken, backendToken } = await setup();

    const response = await fetchFile(app, {
      query: {
        path: 'Private/salaries.xlsx',
        backend: backendToken({ absolutePath: secretFile }, 'not-the-secret'),
      },
      token: dsToken(),
    });

    expect(response.status).toBe(403);
  });

  it('falls back to being refused when it names no file', async () => {
    const { app, dsToken, backendToken } = await setup();

    const response = await fetchFile(app, {
      query: { path: 'report.docx', backend: backendToken({ absolutePath: '' }) },
      token: dsToken(),
    });

    expect(response.status).toBe(403);
  });

  it('refuses a directory', async () => {
    const { app, dsToken, backendToken } = await setup();
    const directory = path.join(currentEnv.volumeDir, 'Private');

    const response = await fetchFile(app, {
      query: { path: 'Private', backend: backendToken({ absolutePath: directory }) },
      token: dsToken(),
    });

    expect(response.status).toBe(400);
  });
});
