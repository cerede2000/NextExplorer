import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Looking inside an archive without unpacking it.
 *
 * An archive could only be extracted whole, which is a lot of disk and a lot of
 * waiting for the one file somebody wanted out of it — and no way at all to see
 * what is in one before deciding. It is now browsed like a folder: the entries
 * are read from the archive's own index, and a single file is read out of it
 * without the rest being written anywhere.
 */

let env;
let app;
let alice;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

/**
 * Reading an archive is 7-Zip's job, so these need it.
 *
 * The image ships it; a machine running the tests may not, and may have it
 * under another name — `7zz` is what Homebrew installs. Found here rather than
 * assumed, and the whole file says so when there is none, because a suite that
 * quietly passes on a machine without the tool is a suite that proves nothing.
 */
const findSevenZip = () => {
  for (const candidate of ['7z', '7zz', '7za']) {
    try {
      execFileSync(candidate, ['i'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next name.
    }
  }
  return null;
};
const sevenZip = findSevenZip();

beforeEach(async () => {
  env = await setupTestEnv({
    tag: 'archive-browse-',
    env: { SEVEN_ZIP_PATH: sevenZip },
  });
  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });

  await fs.mkdir(volume('Packs'), { recursive: true });
  // Written here rather than by 7-Zip: the machine running the tests may not
  // have it, and what is being tested is the reading, not the writing.
  const zip = new AdmZip();
  zip.addFile('readme.txt', Buffer.from('what is in here'));
  zip.addFile('inner/deep.txt', Buffer.from('further in'));
  zip.writeZip(volume('Packs', 'pack.zip'));

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.get('x-test-user') !== 'nobody') req.user = alice;
    next();
  });
  app.use('/api', load('src/routes/archive'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

const list = (inside = '', { who = 'alice' } = {}) =>
  request(app)
    .get('/api/archive/list')
    .set('x-test-user', who)
    .query({ path: 'Packs/pack.zip', ...(inside ? { inside } : {}) });

const entry = (wanted, { who = 'alice' } = {}) =>
  request(app)
    .get('/api/archive/entry')
    .set('x-test-user', who)
    .query({ path: 'Packs/pack.zip', entry: wanted })
    .buffer(true)
    .parse((res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
    });

describe.skipIf(!sevenZip)('an archive', () => {
  it('lists what is at its top, without unpacking it', async () => {
    const listed = await list();

    expect(listed.status).toBe(200);
    expect(listed.body.name).toBe('pack.zip');
    const names = listed.body.entries.map((row) => row.name).sort();
    expect(names).toEqual(['inner', 'readme.txt']);
    // Nothing was written to the volume to answer this.
    expect(await fs.readdir(volume('Packs'))).toEqual(['pack.zip']);
  });

  it('lists what is inside one of its folders', async () => {
    const listed = await list('inner');

    expect(listed.status).toBe(200);
    expect(listed.body.entries.map((row) => row.name)).toEqual(['deep.txt']);
  });

  it('hands over one file out of it', async () => {
    const got = await entry('readme.txt');

    expect(got.status).toBe(200);
    expect(got.body).toBe('what is in here');
  });

  /**
   * A file inside somebody's archive is somebody else's HTML as easily as their
   * photograph. Served inline it would run on this application's origin.
   */
  it('always hands it over as something to save, and never to run', async () => {
    const got = await entry('readme.txt');

    expect(got.headers['content-disposition']).toMatch(/^attachment/);
    expect(got.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers nothing for an entry that is not in it', async () => {
    expect((await entry('nowhere.txt')).status).toBe(404);
  });

  /** The archive is a real path, and the ordinary access rules decide. */
  it('is refused to somebody who may not read it', async () => {
    await load('src/services/accessControlService').setRules([
      { path: 'Packs', permissions: 'hidden', recursive: true },
    ]);

    expect((await list()).status).toBe(403);
  });

  it('refuses a file that is not an archive at all', async () => {
    await fs.writeFile(volume('Packs', 'notes.txt'), 'not an archive');

    const listed = await request(app).get('/api/archive/list').query({ path: 'Packs/notes.txt' });

    expect(listed.status).toBe(400);
  });
});
