import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';

import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A new folder, and whatever arrives under its name first.
 *
 * The route looked for a free name — "Untitled Folder", "Untitled Folder 2" —
 * and created it afterwards. A folder made under that name in between, by
 * another request or over SMB, failed the request with an error that said the
 * server broke. The name is now taken by the mkdir itself, and a taken one
 * moves on to the next.
 */

let currentEnv;

afterEach(async () => {
  vi.restoreAllMocks();
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const setup = async () => {
  currentEnv = await setupTestEnv({ tag: 'folder-create-' });
  const router = currentEnv.requireFresh('src/routes/files/folder');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = createTestApp({
    router,
    mountPath: '/api',
    user: { id: 'admin-user', roles: ['admin'] },
    errorHandler,
  });
  const directory = path.join(currentEnv.volumeDir, 'Documents');
  fs.mkdirSync(directory, { recursive: true });
  return { app, directory };
};

/**
 * Run `arrive` the moment the route first creates `target`, just before it
 * does: the name was free when it was chosen, and is taken now.
 */
const arriveJustBefore = (target, arrive) => {
  const mkdir = fsp.mkdir.bind(fsp);
  let arrived = false;
  vi.spyOn(fsp, 'mkdir').mockImplementation(async (candidate, options) => {
    if (!arrived && candidate === target) {
      arrived = true;
      arrive();
    }
    return mkdir(candidate, options);
  });
};

const names = (directory) => fs.readdirSync(directory).sort();

describe('creating a folder under a name taken at the last moment', () => {
  it('keeps the folder that arrived, and takes the next name', async () => {
    const { app, directory } = await setup();
    arriveJustBefore(path.join(directory, 'Untitled Folder'), () => {
      fs.mkdirSync(path.join(directory, 'Untitled Folder'));
      fs.writeFileSync(path.join(directory, 'Untitled Folder', 'theirs.txt'), 'theirs');
    });

    const created = await request(app).post('/api/files/folder').send({ path: 'Documents' });

    expect(created.status).toBe(201);
    expect(created.body.item.name).toBe('Untitled Folder 2');
    expect(names(path.join(directory, 'Untitled Folder'))).toEqual(['theirs.txt']);
    expect(names(path.join(directory, 'Untitled Folder 2'))).toEqual([]);
  });

  it('keeps a file that arrived under the name, and takes the next one', async () => {
    const { app, directory } = await setup();
    arriveJustBefore(path.join(directory, 'Reports'), () => {
      fs.writeFileSync(path.join(directory, 'Reports'), 'a file, not a folder');
    });

    const created = await request(app)
      .post('/api/files/folder')
      .send({ path: 'Documents', name: 'Reports' });

    expect(created.status).toBe(201);
    expect(created.body.item.name).toBe('Reports 2');
    expect(fs.readFileSync(path.join(directory, 'Reports'), 'utf8')).toBe('a file, not a folder');
    expect(fs.statSync(path.join(directory, 'Reports 2')).isDirectory()).toBe(true);
  });
});

describe('creating folders under names already taken', () => {
  it('numbers the new folder as it always has', async () => {
    const { app, directory } = await setup();
    fs.mkdirSync(path.join(directory, 'Untitled Folder'));
    fs.mkdirSync(path.join(directory, 'Untitled Folder 2'));

    const created = await request(app).post('/api/files/folder').send({ path: 'Documents' });

    expect(created.status).toBe(201);
    expect(created.body.item.name).toBe('Untitled Folder 3');
  });

  it('gives each of several requests at once a folder of its own', async () => {
    const { app, directory } = await setup();

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app).post('/api/files/folder').send({ path: 'Documents' })
      )
    );

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201]);
    expect(responses.map((response) => response.body.item.name).sort()).toEqual([
      'Untitled Folder',
      'Untitled Folder 2',
      'Untitled Folder 3',
      'Untitled Folder 4',
    ]);
    expect(names(directory)).toHaveLength(4);
  });
});
