import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What the path of an access rule names, asked by the rule editor.
 *
 * A rule is matched against the path as the application shows it, volume
 * first. `mnt/torrents` — the folder as the compose file names it, not as the
 * application does — was accepted without a word and matched nothing: a
 * read-only rule that protected no folder (nxzai/NextExplorer#407). The editor
 * now asks, warns, and offers the folder that was probably meant.
 */

let env;

afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

const seed = async () => {
  env = await setupTestEnv({ tag: 'access-rule-paths-' });
  await fs.mkdir(path.join(env.volumeDir, 'torrents', 'films'), { recursive: true });
  await fs.writeFile(path.join(env.volumeDir, 'torrents', 'liste.txt'), 'x');
};

const check = async (paths, user = { id: 'admin-1', roles: ['admin'] }) => {
  const routes = env.requireFresh('src/routes/settings');
  const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = user;
    next();
  });
  server.use('/api', routes);
  server.use(errorHandler);
  return request(server).post('/api/settings/access/check-paths').send({ paths });
};

const statusOf = async (typed) => {
  const response = await check([typed]);
  expect(response.status).toBe(200);
  const [answer] = response.body.paths;
  return { status: answer.status, suggestion: answer.suggestion };
};

describe('the path of a rule', () => {
  it('names a folder when it is typed as the application shows it', async () => {
    await seed();
    expect(await statusOf('torrents')).toEqual({ status: 'folder', suggestion: null });
    expect(await statusOf('torrents/films')).toEqual({ status: 'folder', suggestion: null });
    // The slashes the editor takes off before saving make no difference.
    expect(await statusOf('/torrents/films/')).toEqual({ status: 'folder', suggestion: null });
    expect(await statusOf('torrents/liste.txt')).toEqual({ status: 'file', suggestion: null });
  });

  it('names nothing when written from the host’s side of the mount, and says what was meant', async () => {
    await seed();
    expect(await statusOf('mnt/torrents')).toEqual({ status: 'missing', suggestion: 'torrents' });
    expect(await statusOf('/mnt/torrents/films')).toEqual({
      status: 'missing',
      suggestion: 'torrents/films',
    });
  });

  it('names nothing in other capitals, which a rule would never match, and says what was meant', async () => {
    // A disk that ignores case finds `Torrents` too; a rule compares letter
    // for letter, and would match nothing.
    await seed();
    expect(await statusOf('Torrents/Films')).toEqual({
      status: 'missing',
      suggestion: 'torrents/films',
    });
  });

  it('names nothing, with nothing to offer, when nothing is close', async () => {
    await seed();
    expect(await statusOf('musique')).toEqual({ status: 'missing', suggestion: null });
  });

  it('is found whatever the rules say, since a rule hiding it is what it is for', async () => {
    await seed();
    await env
      .requireFresh('src/services/accessControlService')
      .setRules([{ path: 'torrents', recursive: true, permissions: 'hidden' }]);

    expect(await statusOf('torrents/films')).toEqual({ status: 'folder', suggestion: null });
  });

  it('is refused its place outside the volumes', async () => {
    await seed();
    expect((await statusOf('../etc')).status).toBe('invalid');
    // Personal folders sit inside the volume root and are not part of it.
    expect((await statusOf('_users')).status).toBe('invalid');
    expect((await statusOf('/')).status).toBe('invalid');
    expect((await statusOf('')).status).toBe('empty');
  });

  it('answers each path it was sent, in order', async () => {
    await seed();
    const response = await check(['torrents', 'mnt/torrents', '']);

    expect(response.body.paths.map((answer) => [answer.path, answer.status])).toEqual([
      ['torrents', 'folder'],
      ['mnt/torrents', 'missing'],
      ['', 'empty'],
    ]);
  });
});

describe('asking', () => {
  it('is for administrators', async () => {
    await seed();
    const response = await check(['torrents'], { id: 'user-1', roles: ['user'] });
    expect(response.status).toBe(403);
  });

  it('takes a list, and not an endless one', async () => {
    await seed();
    expect((await check('torrents')).status).toBe(400);
    expect((await check(Array.from({ length: 201 }, () => 'torrents'))).status).toBe(400);
  });
});
