import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A save made through Collabora.
 *
 * Collabora hands the document over itself, so nothing here could destroy a
 * file the way a download that stopped arriving could. What was missing is the
 * other half: the state each save replaced was dropped, so a document edited
 * all afternoon had no history at all — while the same document opened in the
 * text editor did.
 *
 * The saves now go through the versions, which keep what they replace. The
 * editor saves on its own every few minutes, and those automatic saves belong
 * to the session rather than standing as states of their own: the lock every
 * co-editor holds is what says which session a save belongs to.
 */

const SECRET = 'collabora-save-secret';
const DOCUMENT = 'Projects/report.docx';
const FILE_ID = 'file-1';

let env;
let app;
let alice;

const load = (relative) => require(modulePath(relative));

const absolute = () => path.join(env.volumeDir, ...DOCUMENT.split('/'));

beforeEach(async () => {
  env = await setupTestEnv({
    tag: 'collabora-save-',
    env: {
      PUBLIC_URL: 'https://files.example.com',
      COLLABORA_URL: 'https://collabora.example.com',
      COLLABORA_SECRET: SECRET,
    },
  });

  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });

  await fs.mkdir(path.dirname(absolute()), { recursive: true });
  await fs.writeFile(absolute(), 'first');

  app = express();
  app.use('/api', load('src/routes/collabora'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

const accessToken = () =>
  jwt.sign(
    {
      fileId: FILE_ID,
      absolutePath: absolute(),
      canWrite: true,
      userId: alice.id,
      userName: 'Alice',
    },
    SECRET,
    { algorithm: 'HS256', expiresIn: 60 }
  );

/** As Collabora saves: the whole document in the body, and how it came to save. */
const put = (content, { autosave = false, lock = null } = {}) => {
  const call = request(app)
    .post(`/api/collabora/wopi/files/${FILE_ID}/contents`)
    .query({ access_token: accessToken() })
    .set('Content-Type', 'application/octet-stream');
  if (autosave) call.set('X-COOL-WOPI-IsAutosave', 'true');
  if (lock) call.set('X-WOPI-Lock', lock);
  return call.send(Buffer.from(content));
};

const historyOf = async () => {
  const db = await load('src/services/db').getDb();
  const store = load('src/services/versions/store');
  const file = store.listFiles(db)[0] || null;
  return {
    file,
    versions: file ? store.listVersionsOfFile(db, file.id) : [],
  };
};

const contentOf = async (version) => {
  const operations = load('src/services/versions/operations');
  const located = await operations.locateVersion(version.id);
  return fs.readFile(located.absolutePath, 'utf8');
};

describe('a document saved from Collabora', () => {
  it('is written, and what it replaced is kept', async () => {
    const response = await put('second');

    expect(response.status).toBe(200);
    expect(await fs.readFile(absolute(), 'utf8')).toBe('second');

    const { versions } = await historyOf();
    expect(versions).toHaveLength(1);
    expect(await contentOf(versions[0])).toBe('first');
  });

  it('records who saved it, and through which editor', async () => {
    await put('second');

    const { file } = await historyOf();
    expect(file.currentSource).toBe('collabora');
    expect(file.currentAuthorId).toBe(alice.id);
    expect(file.currentAuthorLabel).toBe('Alice');
  });

  /**
   * The editor's own timer, rather than somebody asking: a state on the way to
   * the next one. What keeps it from filling the history is the session, and
   * the session is the lock every co-editor of the document holds.
   */
  it('marks a save the editor made by itself, under the session that made it', async () => {
    await put('second', { autosave: true, lock: 'lock-abc' });

    const { file } = await historyOf();
    expect(file.currentExplicit).toBe(false);
    expect(file.currentSession).toBe('wopi:lock-abc');
  });

  it('marks a save somebody asked for as one', async () => {
    await put('second', { lock: 'lock-abc' });

    const { file } = await historyOf();
    expect(file.currentExplicit).toBe(true);
  });

  /**
   * Saved on purpose, then saved again by the timer: the state somebody chose
   * is kept, rather than being swallowed by the automatic save that follows it.
   */
  it('keeps the state somebody asked for when the timer saves over it', async () => {
    await put('asked for', { lock: 'lock-abc' });
    await put('by the timer', { autosave: true, lock: 'lock-abc' });

    const { versions } = await historyOf();
    const contents = await Promise.all(versions.map(contentOf));
    expect(contents).toContain('asked for');
    expect(await fs.readFile(absolute(), 'utf8')).toBe('by the timer');
  });
});
