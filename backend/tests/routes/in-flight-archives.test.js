import fs from 'node:fs';
import path from 'node:path';

import AdmZip from 'adm-zip';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Extracting and compressing record what they are writing until they are done.
 *
 * A stop half-way used to leave a hidden staging folder, a half-filled folder
 * or a half-written zip in the volume for good. The operations themselves are
 * covered elsewhere; this checks that each one releases its record however it
 * ends — a record left behind by a finished operation would have the next
 * start remove a finished result —, that the record is on disk, naming what is
 * being written, while it works, and that one left by an interrupted run takes
 * only what it names.
 */

let ctx;

afterEach(async () => {
  vi.restoreAllMocks();
  if (ctx) await ctx.cleanup();
  ctx = null;
});

const ADMIN = { id: 'admin-1', roles: ['admin'] };

const setup = async () => {
  ctx = await setupTestEnv({ tag: 'in-flight-archives-' });
  const work = path.join(ctx.volumeDir, 'Work');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'one.txt'), 'one\n');
  const journal = path.join(ctx.cacheDir, 'in-flight');

  // What was on disk the moment each operation recorded itself: the routes take
  // `track` when they load, so it is wrapped before they do.
  const recorded = [];
  const inFlightFiles = ctx.requireFresh('src/services/inFlightFiles');
  const track = inFlightFiles.track;
  vi.spyOn(inFlightFiles, 'track').mockImplementation((target, kind) => {
    const operation = track(target, kind);
    recorded.push(...onDisk(journal).filter((record) => record.path === path.resolve(target)));
    return operation;
  });

  const routes = ctx.requireFresh('src/routes/zip');
  const { errorHandler } = ctx.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = ADMIN;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return { app, work, journal, recorded };
};

const records = (journal) =>
  fs.existsSync(journal) ? fs.readdirSync(journal).filter((n) => n.endsWith('.json')) : [];

const onDisk = (journal) =>
  records(journal).map((name) => JSON.parse(fs.readFileSync(path.join(journal, name), 'utf8')));

const lastEvent = (response) =>
  String(response.text || '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .at(-1);

describe('an archive operation', () => {
  it('releases its record once a compression is done', async () => {
    const { app, work, journal, recorded } = await setup();

    const response = await request(app)
      .post('/api/files/zip/compress')
      .send({ items: [{ name: 'one.txt', path: 'Work' }], destination: 'Work', name: 'bundle' });

    expect(lastEvent(response)).toMatchObject({ type: 'done' });
    expect(fs.existsSync(path.join(work, 'bundle.zip'))).toBe(true);
    expect(recorded).toMatchObject([
      { path: path.join(work, 'bundle.zip'), kind: 'partial-archive' },
    ]);
    expect(records(journal)).toEqual([]);
  });

  it('releases its record once an extraction into a folder is done, and into the current one', async () => {
    const { app, work, journal, recorded } = await setup();
    const zip = new AdmZip();
    zip.addFile('inside.txt', Buffer.from('inside'));
    zip.writeZip(path.join(work, 'sample.zip'));

    const intoFolder = await request(app)
      .post('/api/files/zip/extract')
      .send({ path: 'Work/sample.zip' });
    expect(lastEvent(intoFolder)).toMatchObject({ type: 'done' });
    expect(recorded).toMatchObject([{ path: path.join(work, 'sample'), kind: 'partial-folder' }]);
    expect(records(journal)).toEqual([]);

    const here = await request(app)
      .post('/api/files/zip/extract')
      .send({ path: 'Work/sample.zip', destination: 'current' });
    expect(lastEvent(here)).toMatchObject({ type: 'done' });
    expect(recorded).toHaveLength(2);
    expect(recorded[1].kind).toBe('staging-directory');
    expect(path.dirname(recorded[1].path)).toBe(work);
    expect(path.basename(recorded[1].path)).toMatch(/^\.nextexplorer-extract-/);
    expect(records(journal)).toEqual([]);
    expect(fs.readdirSync(work).some((name) => name.startsWith('.nextexplorer-extract-'))).toBe(
      false
    );
  });

  it('releases its record when the extraction fails', async () => {
    const { app, work, journal } = await setup();
    fs.writeFileSync(path.join(work, 'broken.zip'), 'not an archive at all');

    const response = await request(app)
      .post('/api/files/zip/extract')
      .send({ path: 'Work/broken.zip' });

    expect(lastEvent(response)?.type).toBe('error');
    expect(records(journal)).toEqual([]);
  });

  it('left by a run a stop interrupted, has the next start remove the half-written zip only', async () => {
    const { work, journal } = await setup();
    const partial = path.join(work, 'Archive.zip');
    fs.writeFileSync(partial, 'PK half an archive');
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(
      path.join(journal, 'interrupted.json'),
      JSON.stringify({ path: partial, kind: 'partial-archive', runId: 'an-earlier-run' })
    );

    ctx.requireFresh('src/services/inFlightFiles').sweepInterrupted();

    expect(fs.existsSync(partial)).toBe(false);
    expect(fs.readFileSync(path.join(work, 'one.txt'), 'utf8')).toBe('one\n');
  });
});
