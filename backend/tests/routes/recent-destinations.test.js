import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The folders a user actually files things into.
 *
 * The destination picker opens on this list rather than at the root, so what it
 * contains has to be true without anyone maintaining it: written by the
 * transfers themselves, ordered by use, and holding nothing the person cannot
 * still reach. A destination offered and then refused at the end of the flow
 * would be worse than no list at all.
 */

describe('recent destinations', () => {
  let env;
  const asUser = (id) => ({ id, roles: ['admin'] });

  const setup = async () => {
    env = await setupTestEnv({
      tag: 'recent-destinations-',
      modules: [
        'src/services/db',
        'src/services/recentDestinationsService',
        'src/services/accessManager',
        'src/routes/files',
        'src/middleware/errorHandler',
      ],
    });

    for (const folder of ['Archive', 'Invoices', 'Photos']) {
      await fs.mkdir(path.join(env.volumeDir, folder), { recursive: true });
    }
    await fs.writeFile(path.join(env.volumeDir, 'report.txt'), 'contents');
  };

  const appFor = (user) => {
    const routes = env.requireFresh('src/routes/files');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    return createTestApp({ router: routes, mountPath: '/api', user, errorHandler });
  };

  /** Move a file into a folder, the way the client does. */
  const moveInto = async (app, name, destination) =>
    request(app)
      .post('/api/files/move')
      .send({
        items: [{ name, path: '' }],
        destination,
      });

  const listFor = async (app) => {
    const response = await request(app).get('/api/files/recent-destinations');
    expect(response.status).toBe(200);
    return response.body.items;
  };

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('remembers where a transfer landed, without being asked to', async () => {
    // Nothing in the client reports this: recording it from the transfer means
    // a drag onto a favorite and a paste count exactly like a pick.
    await setup();
    const app = appFor(asUser('alice'));

    expect(await listFor(app)).toEqual([]);

    expect((await moveInto(app, 'report.txt', 'Archive')).status).toBe(200);

    expect(await listFor(app)).toEqual(['Archive']);
  });

  it('puts the destination used most recently first', async () => {
    await setup();
    const app = appFor(asUser('alice'));

    await moveInto(app, 'report.txt', 'Archive');
    await fs.writeFile(path.join(env.volumeDir, 'report.txt'), 'again');
    await moveInto(app, 'report.txt', 'Invoices');

    expect(await listFor(app)).toEqual(['Invoices', 'Archive']);
  });

  it('moves a destination up rather than listing it twice', async () => {
    await setup();
    const app = appFor(asUser('alice'));

    await moveInto(app, 'report.txt', 'Archive');
    await fs.writeFile(path.join(env.volumeDir, 'report.txt'), 'again');
    await moveInto(app, 'report.txt', 'Invoices');
    await fs.writeFile(path.join(env.volumeDir, 'report.txt'), 'once more');
    await moveInto(app, 'report.txt', 'Archive');

    expect(await listFor(app)).toEqual(['Archive', 'Invoices']);
  });

  it('keeps one user habits out of another list', async () => {
    // Where someone files their work says something about it; a favorite is
    // shared deliberately, this is not.
    await setup();
    const alice = appFor(asUser('alice'));
    const bob = appFor(asUser('bob'));

    await moveInto(alice, 'report.txt', 'Archive');

    expect(await listFor(alice)).toEqual(['Archive']);
    expect(await listFor(bob)).toEqual([]);
  });

  it('drops a destination that has since been deleted', async () => {
    // Offering it would only produce a failure at the end of the flow.
    await setup();
    const app = appFor(asUser('alice'));

    await moveInto(app, 'report.txt', 'Archive');
    await fs.rm(path.join(env.volumeDir, 'Archive'), { recursive: true, force: true });

    expect(await listFor(app)).toEqual([]);

    // And forgotten for good, rather than re-tested on every open.
    await fs.mkdir(path.join(env.volumeDir, 'Archive'), { recursive: true });
    expect(await listFor(app)).toEqual([]);
  });

  it('swallows a write it cannot perform, rather than failing the transfer', async () => {
    // The list is a convenience; the file arriving is not. A /config directory
    // shared with an older image is the real way this happens — the schema is
    // behind and the table simply isn't there, which must not turn a successful
    // move into a 500.
    await setup();

    const { getDb } = env.requireFresh('src/services/db');
    const service = env.requireFresh('src/services/recentDestinationsService');
    const db = await getDb();
    db.exec('DROP TABLE recent_destinations');

    await expect(service.record('alice', 'Archive')).resolves.toBeUndefined();
  });
});
