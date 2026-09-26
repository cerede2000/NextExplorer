import fsp from 'node:fs/promises';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * How much of a file a save through a share link reads before writing it.
 *
 * The visitor sends the whole text, so the only thing the file on disk still
 * has to say is what it is written in — three bytes of mark, or the pattern of
 * zeros that betrays a UTF-16 file without one. This asked `readTextFile` for
 * it, which reads and decodes the file whole: a megabyte through the heap, on
 * every save, to look at its first bytes. The editor's own save has always
 * read just the head.
 *
 * The refusals that call was also making are the other half of it, and they
 * are what makes replacing it more than a one-line change: a writable share
 * must not become a way to write over a directory, a binary, or a file the
 * editor would refuse to open.
 */

let env;
let assignedRoot;
let readFile;

const load = (relative) => require(modulePath(relative));

const EDITOR_LIMIT = 65536;

beforeEach(async () => {
  env = await setupTestEnv({
    tag: 'share-editor-save-',
    env: { USER_VOLUMES: 'true', EDITOR_MAX_FILESIZE: String(EDITOR_LIMIT) },
  });
  assignedRoot = path.join(env.tmpRoot, 'assigned');
  await fsp.mkdir(assignedRoot, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
  readFile = null;
});

const buildApp = ({ user } = {}) => {
  const application = express();
  application.use(express.json({ limit: load('src/config/index').uploads.maxJsonBodyBytes }));
  application.use(cookieParser());
  application.use((req, _res, next) => {
    req.session = user ? { localUserId: user.id } : {};
    next();
  });
  application.use(load('src/middleware/authMiddleware'));
  application.use('/api/shares', load('src/routes/shares'));
  application.use('/api/share', load('src/routes/shares'));
  application.use(load('src/middleware/errorHandler').errorHandler);
  return application;
};

/** An "anyone" share of `sourceName` inside the owner's assigned volume. */
const shareOf = async (sourceName, { accessMode = 'readwrite' } = {}) => {
  const owner = await load('src/services/users').createLocalUser({
    email: `owner-${sourceName.replace(/\W/g, '-')}@example.com`,
    username: `owner-${sourceName.replace(/\W/g, '-')}`,
    displayName: 'Owner',
    password: 'secret123',
    roles: ['user'],
  });
  await load('src/services/userVolumesService').addVolumeToUser({
    userId: owner.id,
    label: 'Assigned',
    volumePath: assignedRoot,
    accessMode: 'readwrite',
  });
  const create = await request(buildApp({ user: owner }))
    .post('/api/shares')
    .send({
      sourcePath: `Assigned/${sourceName}`,
      accessMode,
      sharingType: 'anyone',
    });
  expect(create.status).toBe(201);
  return create.body.shareToken;
};

const save = (token, content) =>
  request(buildApp()).put(`/api/share/${token}/editor`).send({ content });

/** Every whole-file read of a path ending in `name`, as the spy saw them. */
const wholeReadsOf = (name) =>
  readFile.mock.calls.filter(([target]) => String(target).endsWith(name));

const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

describe('saving a text file through a share link', () => {
  it('learns the encoding from the head of the file, not from the whole of it', async () => {
    // Comfortably past what the detection looks at, and still under the limit,
    // so a whole read is a choice and not the only way to see the file.
    const original = 'Nom de la machine : POSTE-042\r\nStatut : à jour\r\n'.repeat(400);
    const target = path.join(assignedRoot, 'inventaire.txt');
    await fsp.writeFile(target, utf16le(original));
    expect((await fsp.stat(target)).size).toBeGreaterThan(16 * 1024);
    const token = await shareOf('inventaire.txt');

    readFile = vi.spyOn(fsp, 'readFile');
    const response = await save(token, 'Statut : remplacé\r\n');

    expect(response.status).toBe(200);
    expect(wholeReadsOf('inventaire.txt')).toEqual([]);
    // And the head was enough: the file keeps the encoding it had, mark and all.
    const written = await fsp.readFile(target);
    expect(written.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(written.subarray(2).toString('utf16le')).toBe('Statut : remplacé\r\n');
  });

  it('still refuses a file the editor calls binary', async () => {
    const target = path.join(assignedRoot, 'archive.bin');
    await fsp.writeFile(target, Buffer.alloc(4096));
    const token = await shareOf('archive.bin');

    const response = await save(token, 'plain text');

    expect(response.status).toBe(415);
    expect((await fsp.readFile(target)).length).toBe(4096);
  });

  it('still refuses a file already past the editor limit', async () => {
    const target = path.join(assignedRoot, 'journal.log');
    await fsp.writeFile(target, 'x'.repeat(EDITOR_LIMIT + 1));
    const token = await shareOf('journal.log');

    const response = await save(token, 'trimmed');

    expect(response.status).toBe(400);
    expect((await fsp.readFile(target, 'utf8')).length).toBe(EDITOR_LIMIT + 1);
  });

  it('still refuses to write over a directory', async () => {
    await fsp.mkdir(path.join(assignedRoot, 'minutes'), { recursive: true });
    const token = await shareOf('minutes');

    const response = await save(token, 'not a folder');

    expect(response.status).toBe(400);
    expect((await fsp.stat(path.join(assignedRoot, 'minutes'))).isDirectory()).toBe(true);
  });

  /**
   * A link that only reads is the case this route exists to keep apart from
   * the one that writes: the editor opens on both, and offers to save on one.
   */
  it('refuses a link that was not made writable', async () => {
    const target = path.join(assignedRoot, 'lecture.txt');
    await fsp.writeFile(target, 'à lire seulement');
    const token = await shareOf('lecture.txt', { accessMode: 'readonly' });

    // It still opens: reading is what the link is for.
    const opened = await request(buildApp()).get(`/api/share/${token}/editor`);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ canWrite: false });

    const response = await save(token, 'réécrit quand même');

    expect(response.status).toBe(403);
    expect(await fsp.readFile(target, 'utf8')).toBe('à lire seulement');
  });
});
