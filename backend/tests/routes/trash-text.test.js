import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Reading a file that is in the trash.
 *
 * Deciding whether to restore something or delete it for good means looking at
 * it, and until now the trash could only be looked at from the outside: a name,
 * a size and a date. The only route that reached into an item listed a deleted
 * folder's entries; nothing could open one.
 *
 * Read only, deliberately: there is no route that writes into the trash, so a
 * file goes back to a volume before it can be changed.
 */

let env;
let app;
let users;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

const write = async (relative, content) => {
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
};

const as = (who) => ({
  get: (url) => request(app).get(url).set('x-test-user', who),
  del: (url, body) => request(app).delete(url).set('x-test-user', who).send(body),
});

const trashAs = (who, parent, name) =>
  as(who).del('/api/files', { items: [{ path: parent, name }] });

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'trash-text-', env: { USER_DIR_ENABLED: 'true' } });

  const usersService = load('src/services/users');
  const make = (name, roles) =>
    usersService.createLocalUser({
      email: `${name}@example.com`,
      username: name,
      displayName: name[0].toUpperCase() + name.slice(1),
      password: 'secret123',
      roles,
    });
  users = { alice: await make('alice', ['user']), bob: await make('bob', ['user']) };

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who) req.user = users[who];
    next();
  });
  app.use('/api', load('src/routes/files'));
  app.use('/api', load('src/routes/trash'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

const textOf = (who, id, entryPath) =>
  as(who).get(
    `/api/trash/items/${id}/text${entryPath ? `?path=${encodeURIComponent(entryPath)}` : ''}`
  );

describe('a file in the trash', () => {
  it('shows its text, with the name it had', async () => {
    await write('Projects/report.txt', 'quarterly figures');
    const { body } = await trashAs('alice', 'Projects', 'report.txt');
    const id = body.items[0].trashItemId;

    const response = await textOf('alice', id);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: 'report.txt', content: 'quarterly figures' });
  });

  it('shows a file from inside a deleted folder', async () => {
    await write('Projects/notes/minutes.md', 'what was decided');
    const { body } = await trashAs('alice', 'Projects', 'notes');
    const id = body.items[0].trashItemId;

    const response = await textOf('alice', id, 'minutes.md');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: 'minutes.md', content: 'what was decided' });
  });

  it('decodes a file written in UTF-16, as the editor does', async () => {
    await write('Projects/export.txt', Buffer.from('﻿written on Windows', 'utf16le'));
    const { body } = await trashAs('alice', 'Projects', 'export.txt');

    const response = await textOf('alice', body.items[0].trashItemId);

    expect(response.body.content).toBe('written on Windows');
  });

  it('refuses a file that is not text', async () => {
    await write(
      'Projects/image.bin',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 1, 2, 3, 4])
    );
    const { body } = await trashAs('alice', 'Projects', 'image.bin');

    expect((await textOf('alice', body.items[0].trashItemId)).status).toBe(415);
  });

  it('refuses a folder', async () => {
    await write('Projects/notes/minutes.md', 'what was decided');
    const { body } = await trashAs('alice', 'Projects', 'notes');

    expect((await textOf('alice', body.items[0].trashItemId)).status).toBe(400);
  });

  /** The whole point of the item id: nothing outside the deleted item is reachable. */
  it('refuses a path that climbs out of the item', async () => {
    await write('Projects/notes/minutes.md', 'what was decided');
    await write('Projects/secret.txt', 'not deleted');
    const { body } = await trashAs('alice', 'Projects', 'notes');

    const response = await textOf('alice', body.items[0].trashItemId, '../secret.txt');

    expect(response.status).toBe(400);
  });

  it('is not readable by somebody it is not in the trash of', async () => {
    await write('Projects/report.txt', 'quarterly figures');
    const { body } = await trashAs('alice', 'Projects', 'report.txt');

    const response = await textOf('bob', body.items[0].trashItemId);

    expect(response.status).toBe(404);
  });

  it('answers nothing for an item that is not there', async () => {
    expect((await textOf('alice', 'nosuchitem')).status).toBe(404);
  });

  /** What one person may read is decided for that person, so no cache holds it. */
  it('is never cached', async () => {
    await write('Projects/report.txt', 'quarterly figures');
    const { body } = await trashAs('alice', 'Projects', 'report.txt');

    const response = await textOf('alice', body.items[0].trashItemId);

    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});
