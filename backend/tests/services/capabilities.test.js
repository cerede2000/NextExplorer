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

describe('the version each tool says it is', () => {
  // Real first lines, taken from the tools and from their sources — the banner
  // each one writes about itself, with the variants a distribution or a build
  // produces. A pattern that reads a number from anywhere else would show a
  // copyright year or a protocol number as a version.
  const said = {
    ffmpeg: [
      ['ffmpeg version 8.1.3 Copyright (c) 2000-2026 the FFmpeg developers', '8.1.3'],
      ['ffmpeg version 7.1.1-1+b1 Copyright (c) 2000-2025 the FFmpeg developers', '7.1.1-1+b1'],
      ['ffmpeg version N-118000-g1234567890 Copyright (c) 2000-2026', 'N-118000-g1234567890'],
    ],
    ffprobe: [['ffprobe version 8.1.3 Copyright (c) 2007-2026 the FFmpeg developers', '8.1.3']],
    ripgrep: [
      ['ripgrep 14.1.1\n\nfeatures:-simd-accel,+pcre2\nsimd(compile):+SSE2', '14.1.1'],
      ['ripgrep 14.1.0 (rev e50df40a19)\n\nfeatures:+pcre2', '14.1.0'],
    ],
    pdftotext: [
      [
        'pdftotext version 26.09.0\nCopyright 2005-2026 The Poppler Developers - http://poppler.freedesktop.org',
        '26.09.0',
      ],
      ['pdftotext version 4.04 [www.xpdfreader.com]\nCopyright 1996-2022 Glyph & Cog, LLC', '4.04'],
    ],
    exiftool: [
      ['13.59\n', '13.59'],
      ['12.76', '12.76'],
    ],
    rsync: [
      [
        'rsync  version 3.4.1  protocol version 32\nCopyright (C) 1996-2025 by Andrew Tridgell',
        '3.4.1',
      ],
      ['rsync  version 3.2.7  protocol version 31', '3.2.7'],
    ],
    '7-Zip': [
      ['\n7-Zip (z) 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-04-14\n', '26.03'],
      ['\n7-Zip 23.01 (arm64) : Copyright (c) 1999-2023 Igor Pavlov : 2023-06-20\n', '23.01'],
      ['\n7-Zip (a) 24.09 (x64) : Copyright (c) 1999-2024 Igor Pavlov : 2024-11-29\n', '24.09'],
      [
        '\n7-Zip [64] 16.02 : Copyright (c) 1999-2016 Igor Pavlov : 2016-05-21\np7zip Version 16.02',
        '16.02',
      ],
    ],
  };

  for (const [name, cases] of Object.entries(said)) {
    for (const [output, version] of cases) {
      it(`reads ${version} out of what ${name} prints`, async () => {
        const { capabilities } = await load();
        expect(capabilities.parseVersion(name, output)).toBe(version);
      });
    }
  }

  it('answers nothing rather than a number that is not the version', async () => {
    const { capabilities } = await load();
    // openrsync is not rsync 2.6.9, whatever its second line claims.
    expect(
      capabilities.parseVersion(
        'rsync',
        'openrsync: protocol version 29\nrsync version 2.6.9 compatible'
      )
    ).toBeNull();
    // A copyright year is not a version.
    expect(capabilities.parseVersion('7-Zip', 'Copyright (c) 1999-2026 Igor Pavlov')).toBeNull();
    // Nor is an answer from something else that happens to be on the path.
    expect(capabilities.parseVersion('ffmpeg', 'avconv version 12.3')).toBeNull();
    expect(capabilities.parseVersion('ripgrep', '')).toBeNull();
    expect(capabilities.parseVersion('ffmpeg', undefined)).toBeNull();
  });

  it('gives each tool the version it said, and none to a tool that is missing', async () => {
    const { capabilities } = await load();
    const list = await capabilities.describe({
      ...everything,
      pdftotext: false,
      versions: { ffmpeg: '8.1.3', '7-Zip': '26.03', pdftotext: '26.09.0' },
    });
    const version = (name) => list.find((c) => c.name === name).version;

    expect(version('ffmpeg')).toBe('8.1.3');
    expect(version('7-Zip')).toBe('26.03');
    // Present and silent about its version: shown without one, not as "unknown".
    expect(version('ripgrep')).toBeNull();
    // Missing: whatever was passed, there is no version of a tool that is not there.
    expect(version('pdftotext')).toBeNull();
  });

  it('names the versions in the line written at start', async () => {
    const { capabilities, info } = await load();
    await capabilities.report({ ...everything, versions: { ffmpeg: '8.1.3', ripgrep: '14.1.1' } });

    const [fields, line] = info.mock.calls[0];
    expect(line).toContain('ffmpeg 8.1.3');
    expect(line).toContain('ripgrep 14.1.1');
    // A tool whose version is not known is still named, without a number.
    expect(line).toMatch(/pdftotext(,|$)/);
    expect(fields.versions).toMatchObject({ ffmpeg: '8.1.3', pdftotext: null });
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
      expect(capability).toHaveProperty('version');
      if (!capability.available) expect(capability.version).toBeNull();
    }
  });

  it('reads the version of the ffmpeg the thumbnails use, off the machine itself', async (ctx) => {
    // The whole way through — the binary the service resolved, its output, the
    // pattern, the answer — and on the machine rather than on a string. Skipped,
    // and said to be, where there is no ffmpeg to ask: passing there would
    // prove nothing.
    env = await setupTestEnv({ tag: 'capabilities-route-version-' });
    const { hasFfmpeg } = env.requireFresh('src/services/ffmpegRunner');
    if (!hasFfmpeg()) ctx.skip();

    const response = await request(app(['admin'])).get('/api/capabilities');
    const ffmpeg = response.body.capabilities.find((c) => c.name === 'ffmpeg');

    expect(ffmpeg.available).toBe(true);
    expect(ffmpeg.version).toMatch(/\d/);
  });

  it('is refused to anybody else', async () => {
    env = await setupTestEnv({ tag: 'capabilities-route-user-' });

    const response = await request(app(['user'])).get('/api/capabilities');

    expect(response.status).toBe(403);
  });
});
