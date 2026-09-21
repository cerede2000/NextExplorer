import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Which optional tools an installation has, said once at start and on demand.
 *
 * The probes existed and nearly all of them were silent: the log named a
 * missing ffmpeg and listed the archive formats 7-Zip had, and said nothing of
 * ripgrep, pdftotext, rsync or ExifTool — nor of the one format a packaged
 * 7-Zip usually drops (#9).
 *
 * What the machine answers is passed in here, because what a CI runner has
 * installed is not this test's to choose. The probes themselves are the ones
 * each service already runs.
 */

let env = null;

afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
  vi.restoreAllMocks();
});

const everything = {
  ffmpeg: true,
  ffprobe: true,
  ripgrep: true,
  rsync: true,
  pdftotext: true,
  exiftool: 'bundled',
  sevenZip: true,
  missingFormats: [],
  nativeTransfers: true,
};

const load = async () => {
  env = await setupTestEnv({ tag: 'capabilities-' });
  // The logger first, so the service is loaded against the instance being
  // watched rather than one it captured before the spy was set.
  const logger = env.requireFresh('src/utils/logger');
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  const capabilities = env.requireFresh('src/services/capabilities');
  return { capabilities, warn, info };
};

const warnings = (warn) => warn.mock.calls.map(([, message]) => message);

describe('the report of optional tools', () => {
  it('names every one, in a fixed order', async () => {
    const { capabilities } = await load();
    const names = (await capabilities.describe(everything)).map((c) => c.name);
    expect(names).toEqual([
      'ffmpeg',
      'ffprobe',
      'ripgrep',
      'pdftotext',
      'exiftool',
      'rsync',
      '7-Zip',
    ]);
  });

  it('says nothing is missing when nothing is', async () => {
    const { capabilities, warn, info } = await load();
    await capabilities.report(everything);

    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls[0][1]).toContain('ripgrep');
  });

  it('says what a missing tool costs, and which package brings it back', async () => {
    const { capabilities, warn } = await load();
    await capabilities.report({ ...everything, ripgrep: false, pdftotext: false });

    const said = warnings(warn);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('ripgrep not found');
    expect(said[0]).toContain('Package: ripgrep');
    // The package is not always named after the tool, which is the point of
    // saying it.
    expect(said[1]).toContain('Package: poppler-utils');
  });

  it('says which archive formats are missing, not only which are there', async () => {
    const { capabilities, warn } = await load();
    await capabilities.report({ ...everything, missingFormats: ['rar'] });

    const said = warnings(warn);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('cannot open rar');
    // Debian's 7zip dropped the codec; this is the package that puts it back.
    expect(said[0]).toContain('7zip-rar');
  });

  it('does not report missing formats of a 7-Zip that is not there at all', async () => {
    // One line for the missing program, not a second listing everything it
    // would have opened.
    const { capabilities, warn } = await load();
    await capabilities.report({ ...everything, sevenZip: false, missingFormats: ['rar', '7z'] });

    const said = warnings(warn);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('7-Zip not found');
  });

  it('leaves rsync out when the transfer engine does not use it', async () => {
    // Sending somebody to install a tool that would change nothing is worse
    // than saying nothing.
    const { capabilities, warn } = await load();
    await capabilities.report({ ...everything, rsync: false, nativeTransfers: false });

    expect(warn).not.toHaveBeenCalled();
  });

  it('reports rsync missing when the transfer engine does use it', async () => {
    const { capabilities, warn } = await load();
    await capabilities.report({ ...everything, rsync: false, nativeTransfers: true });

    expect(warnings(warn)[0]).toContain('rsync not found');
  });

  it('says where RAW previews would come from', async () => {
    const { capabilities } = await load();
    const exiftool = (list) => list.find((c) => c.name === 'exiftool');

    expect(
      exiftool(await capabilities.describe({ ...everything, exiftool: 'machine' }))
    ).toMatchObject({
      available: true,
      source: 'machine',
    });
    expect(exiftool(await capabilities.describe({ ...everything, exiftool: null }))).toMatchObject({
      available: false,
      source: null,
    });
  });
});

describe('GET /api/capabilities', () => {
  const app = (roles) => {
    const routes = env.requireFresh('src/routes/capabilities');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    const server = express();
    server.use((req, _res, next) => {
      req.user = { id: 'u1', email: 'u@example.com', roles };
      next();
    });
    server.use('/api', routes);
    server.use(errorHandler);
    return server;
  };

  it('answers an administrator with the real machine, whatever it has', async () => {
    env = await setupTestEnv({ tag: 'capabilities-route-' });

    const response = await request(app(['admin'])).get('/api/capabilities');

    expect(response.status).toBe(200);
    expect(response.body.capabilities).toHaveLength(7);
    for (const capability of response.body.capabilities) {
      expect(typeof capability.available).toBe('boolean');
      expect(typeof capability.install).toBe('string');
      // The log's English stays in the log; the page translates the key.
      expect(capability).not.toHaveProperty('lost');
    }
  });

  it('is refused to anybody else', async () => {
    env = await setupTestEnv({ tag: 'capabilities-route-user-' });

    const response = await request(app(['user'])).get('/api/capabilities');

    expect(response.status).toBe(403);
  });
});
