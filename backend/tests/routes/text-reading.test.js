import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Text a file holds, wherever it is: the file itself, an earlier version of it,
 * or a file that is in the trash.
 *
 * All three answer through one reader, which is the point of it. Before it there
 * were three ways to be told a file was unopenable and only one of them was
 * true: the editor called a zero byte binary, and in UTF-16 every letter of
 * English is accompanied by one — so a log written by PowerShell, or a file
 * saved from Notepad as "Unicode", was answered "this file appears to be binary"
 * about plain text. A save then wrote UTF-8 over it, which reads perfectly here
 * and breaks whatever wrote it.
 */

const DOCUMENT = 'Notes/journal.md';

let env;
let app;
let alice;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

const write = async (relative, content) => {
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
};

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'text-reading-' });

  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });

  app = express();
  // The body limit the application uses: a save has to reach the route before
  // the route's own limit can be the one that refuses it.
  app.use(express.json({ limit: load('src/config').uploads.maxJsonBodyBytes }));
  app.use((req, _res, next) => {
    req.user = alice;
    next();
  });
  app.use('/api', load('src/routes/editor'));
  app.use('/api', load('src/routes/versions'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

const save = (content, file = DOCUMENT) =>
  request(app).put('/api/editor').send({ path: file, content });

const read = (file = DOCUMENT) => request(app).get('/api/editor').query({ path: file });

describe('opening a file in the editor', () => {
  it('opens a UTF-16 file as the text it is', async () => {
    // What `Out-File` wrote by default until PowerShell 6, and what Notepad
    // still offers as "Unicode": a mark, then two bytes per character.
    await write(DOCUMENT, Buffer.from('﻿quarterly figures', 'utf16le'));

    const response = await read();

    expect(response.status).toBe(200);
    expect(response.body.content).toBe('quarterly figures');
  });

  it('opens a UTF-16 file that carries no mark', async () => {
    await write(DOCUMENT, Buffer.from('the pairing alone has to decide this', 'utf16le'));

    expect((await read()).body.content).toBe('the pairing alone has to decide this');
  });

  it('still refuses a file that really is binary', async () => {
    await write(
      DOCUMENT,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    );

    expect((await read()).status).toBe(415);
  });

  /**
   * The editor is opened from the Markdown preview, which has just downloaded
   * the same file: the second read is a revalidation, not a download.
   */
  it('answers a browser that already holds the file', async () => {
    await write(DOCUMENT, 'quarterly figures');
    const first = await read();
    expect(first.headers.etag).toBeTruthy();

    const again = await read().set('If-None-Match', first.headers.etag);

    expect(again.status).toBe(304);
    expect(again.text).toBe('');
  });

  it('hands the file over again once it has changed', async () => {
    await write(DOCUMENT, 'quarterly figures');
    const first = await read();
    await write(DOCUMENT, 'revised figures');

    const again = await read().set('If-None-Match', first.headers.etag);

    expect(again.status).toBe(200);
    expect(again.body.content).toBe('revised figures');
  });
});

describe('saving from the editor', () => {
  /**
   * The editor opens two megabytes and saves through a JSON body, whose limit
   * was Express's own default of 100 kB: a file between the two opened and
   * could never be saved, answered "request entity too large" — which names
   * neither limit. The body limit is now derived from the editor's.
   */
  it('saves a file larger than a default JSON body', async () => {
    await write(DOCUMENT, 'small');
    const bigger = 'x'.repeat(200 * 1024);

    expect((await save(bigger)).status).toBe(200);

    expect(await fs.readFile(volume(DOCUMENT), 'utf8')).toBe(bigger);
  });

  it('writes back in the encoding the file already had', async () => {
    await write(DOCUMENT, Buffer.from('﻿first', 'utf16le'));

    expect((await save('second')).status).toBe(200);

    const bytes = await fs.readFile(volume(DOCUMENT));
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(bytes.toString('utf16le').replace('﻿', '')).toBe('second');
    // And it reads back as what was typed, not as two bytes per character.
    expect((await read()).body.content).toBe('second');
  });

  it('writes a new file in UTF-8', async () => {
    expect((await save('brand new')).status).toBe(200);

    expect(await fs.readFile(volume(DOCUMENT), 'utf8')).toBe('brand new');
  });

  /**
   * The size limit was checked when opening and not when saving, so a paste
   * larger than the limit was written and then could not be opened again.
   */
  it('refuses a save larger than the editor can open', async () => {
    await write(DOCUMENT, 'small');
    const limit = load('src/services/textEditorService').MAX_EDITOR_FILE_SIZE;

    const refused = await save('x'.repeat(limit + 1));

    expect(refused.status).toBe(400);
    expect(await fs.readFile(volume(DOCUMENT), 'utf8')).toBe('small');
  });

  /**
   * In UTF-16 the same text is twice the bytes, and the bytes are what the
   * limit is about: a file just under it in UTF-8 is over it here.
   */
  it('counts the bytes it is about to write, not the characters', async () => {
    await write(DOCUMENT, Buffer.from('﻿small', 'utf16le'));
    const limit = load('src/services/textEditorService').MAX_EDITOR_FILE_SIZE;

    const refused = await save('x'.repeat(limit - 10));

    expect(refused.status).toBe(400);
  });
});

describe('reading a version as text', () => {
  const textOf = (id, forPath = DOCUMENT) =>
    request(app).get(`/api/versions/${id}/text`).query({ path: forPath });

  const history = () => request(app).get('/api/versions').query({ path: DOCUMENT });

  it('hands over what a version holds, with its name', async () => {
    await save('first');
    await save('second');
    const [version] = (await history()).body.versions;

    const response = await textOf(version.id);

    expect(response.status).toBe(200);
    expect(response.body.content).toBe('first');
    expect(response.body.name).toBe('journal.md');
  });

  it('decodes a version written in UTF-16', async () => {
    await write(DOCUMENT, Buffer.from('﻿first', 'utf16le'));
    await save('second');
    const [version] = (await history()).body.versions;

    expect((await textOf(version.id)).body.content).toBe('first');
  });

  it('refuses a version that belongs to another file', async () => {
    await save('first');
    await save('second');
    const [version] = (await history()).body.versions;
    await save('elsewhere', 'Notes/other.md');

    expect((await textOf(version.id, 'Notes/other.md')).status).toBe(404);
  });

  /** A version is read, never kept: two people's rights differ on the same bytes. */
  it('never lets a version be cached', async () => {
    await save('first');
    await save('second');
    const [version] = (await history()).body.versions;

    expect((await textOf(version.id)).headers['cache-control']).toBe('private, no-store');
  });
});
