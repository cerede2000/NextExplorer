import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import express from 'express';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { setupTestEnv, clearModuleCache, modulePath } from '../helpers/env-test-utils.js';

let envContext;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'archive-extract-test-',
    modules: [
      'src/services/db',
      'src/services/users',
      'src/services/archiveService',
      'src/utils/pathUtils',
      'src/middleware/errorHandler',
      'src/routes/zip',
    ],
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Put something under `target` just before the first filesystem call that
 * would take that name — a rename, a link, an exclusive create, a mkdir —:
 * after the name was seen free, before anything is put there.
 */
const arriveBeforeTaking = (target, arrive) => {
  let arrived = false;
  const at = (method, targetOf) => {
    const original = fs[method].bind(fs);
    vi.spyOn(fs, method).mockImplementation(async (...args) => {
      if (!arrived && path.resolve(String(targetOf(args))) === path.resolve(target)) {
        arrived = true;
        await arrive();
      }
      return original(...args);
    });
  };
  at('rename', (args) => args[1]);
  at('link', (args) => args[1]);
  at('open', (args) => args[0]);
  at('mkdir', (args) => args[0]);
  return () => arrived;
};

const journalRecords = () => {
  const journal = path.join(envContext.cacheDir, 'in-flight');
  return fss.existsSync(journal) ? fss.readdirSync(journal).filter((n) => n.endsWith('.json')) : [];
};

const buildApp = ({ user } = {}) => {
  if (!envContext) throw new Error('Test environment not initialized');

  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');

  const zipRoutes = envContext.requireFresh('src/routes/zip');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', zipRoutes);
  app.use(errorHandler);
  return app;
};

const adminUser = { id: 'admin', roles: ['admin'] };

// The extract endpoint streams NDJSON events (start/progress/done/error).
const parseNdjson = (text) =>
  String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('Archive extraction', () => {
  it('extracts a zip archive into a sibling folder, streaming its status', async () => {
    const workDir = path.join(envContext.volumeDir, 'archives');
    await fs.mkdir(workDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile('hello.txt', Buffer.from('hello archive'));
    zip.addFile('nested/deep.txt', Buffer.from('nested content'));
    zip.writeZip(path.join(workDir, 'sample.zip'));

    const app = buildApp({ user: adminUser });
    const response = await request(app)
      .post('/api/files/zip/extract')
      .send({ path: 'archives/sample.zip' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');

    const events = parseNdjson(response.text);
    expect(events[0]).toMatchObject({ type: 'start', name: 'sample' });
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.item?.name).toBe('sample');
    expect(done.item?.kind).toBe('directory');

    const extractedRoot = path.join(workDir, 'sample');
    expect(await fs.readFile(path.join(extractedRoot, 'hello.txt'), 'utf8')).toBe('hello archive');
    expect(await fs.readFile(path.join(extractedRoot, 'nested', 'deep.txt'), 'utf8')).toBe(
      'nested content'
    );
  });

  it('extracts root entries directly into the current folder on request', async () => {
    const workDir = path.join(envContext.volumeDir, 'archives-current');
    await fs.mkdir(workDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile('hello.txt', Buffer.from('hello archive'));
    zip.addFile('nested/deep.txt', Buffer.from('nested content'));
    zip.writeZip(path.join(workDir, 'sample.zip'));

    const app = buildApp({ user: adminUser });
    const response = await request(app)
      .post('/api/files/zip/extract')
      .send({ path: 'archives-current/sample.zip', destination: 'current' });

    expect(response.status).toBe(200);
    const done = parseNdjson(response.text).at(-1);
    expect(done).toMatchObject({ type: 'done', success: true });
    expect(done.item).toBeNull();
    expect(done.items.map((item) => item.name).sort()).toEqual(['hello.txt', 'nested']);
    expect(await fs.readFile(path.join(workDir, 'hello.txt'), 'utf8')).toBe('hello archive');
    expect(await fs.readFile(path.join(workDir, 'nested', 'deep.txt'), 'utf8')).toBe(
      'nested content'
    );
    expect(await fs.readdir(workDir)).not.toContain('sample');
  });

  it('renames conflicting root entries when extracting into the current folder', async () => {
    const workDir = path.join(envContext.volumeDir, 'archives-collision');
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, 'report.txt'), 'existing file');

    const zip = new AdmZip();
    zip.addFile('report.txt', Buffer.from('archive file'));
    zip.writeZip(path.join(workDir, 'sample.zip'));

    const app = buildApp({ user: adminUser });
    const response = await request(app)
      .post('/api/files/zip/extract')
      .send({ path: 'archives-collision/sample.zip', destination: 'current' });

    expect(response.status).toBe(200);
    const done = parseNdjson(response.text).at(-1);
    expect(done.item?.name).toBe('report (1).txt');
    expect(await fs.readFile(path.join(workDir, 'report.txt'), 'utf8')).toBe('existing file');
    expect(await fs.readFile(path.join(workDir, 'report (1).txt'), 'utf8')).toBe('archive file');
  });

  /**
   * What an extraction puts in a folder takes its names by the step that puts
   * it there. A name seen free and renamed into afterwards lost whatever
   * arrived under it in between — a file saved over SMB, a folder someone just
   * created —, which rename(2) replaces without a word.
   */
  it('never replaces a file that arrives under an entry’s name just before it is moved in', async () => {
    const workDir = path.join(envContext.volumeDir, 'arrive-file');
    await fs.mkdir(workDir, { recursive: true });
    const zip = new AdmZip();
    zip.addFile('report.txt', Buffer.from('archive file'));
    zip.writeZip(path.join(workDir, 'sample.zip'));
    const target = path.join(workDir, 'report.txt');
    const theirs = Buffer.from('saved over SMB meanwhile\n');
    const arrived = arriveBeforeTaking(target, () => fs.writeFile(target, theirs));

    const response = await request(buildApp({ user: adminUser }))
      .post('/api/files/zip/extract')
      .send({ path: 'arrive-file/sample.zip', destination: 'current' });

    expect(arrived()).toBe(true);
    const done = parseNdjson(response.text).at(-1);
    expect(done).toMatchObject({ type: 'done', item: { name: 'report (1).txt' } });
    expect(await fs.readFile(target)).toEqual(theirs);
    expect(await fs.readFile(path.join(workDir, 'report (1).txt'), 'utf8')).toBe('archive file');
    expect((await fs.readdir(workDir)).sort()).toEqual([
      'report (1).txt',
      'report.txt',
      'sample.zip',
    ]);
  });

  it('never fills an empty folder that appears under an entry’s name just before it is moved in', async () => {
    const workDir = path.join(envContext.volumeDir, 'arrive-empty-folder');
    await fs.mkdir(workDir, { recursive: true });
    const zip = new AdmZip();
    zip.addFile('nested/deep.txt', Buffer.from('nested content'));
    zip.writeZip(path.join(workDir, 'sample.zip'));
    const target = path.join(workDir, 'nested');
    const arrived = arriveBeforeTaking(target, () => fs.mkdir(target));

    const response = await request(buildApp({ user: adminUser }))
      .post('/api/files/zip/extract')
      .send({ path: 'arrive-empty-folder/sample.zip', destination: 'current' });

    expect(arrived()).toBe(true);
    const done = parseNdjson(response.text).at(-1);
    expect(done).toMatchObject({ type: 'done', item: { name: 'nested (1)', kind: 'directory' } });
    expect(await fs.readdir(target)).toEqual([]);
    expect(await fs.readFile(path.join(workDir, 'nested (1)', 'deep.txt'), 'utf8')).toBe(
      'nested content'
    );
    expect((await fs.readdir(workDir)).sort()).toEqual(['nested', 'nested (1)', 'sample.zip']);
  });

  it('never merges into a folder that appears under the new folder’s name, nor records it', async () => {
    const workDir = path.join(envContext.volumeDir, 'arrive-folder');
    await fs.mkdir(workDir, { recursive: true });
    const zip = new AdmZip();
    zip.addFile('inside.txt', Buffer.from('inside'));
    zip.writeZip(path.join(workDir, 'sample.zip'));
    const target = path.join(workDir, 'sample');
    const theirs = Buffer.from('put here by someone else\n');
    const arrived = arriveBeforeTaking(target, async () => {
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'theirs.txt'), theirs);
    });

    const response = await request(buildApp({ user: adminUser }))
      .post('/api/files/zip/extract')
      .send({ path: 'arrive-folder/sample.zip' });

    expect(arrived()).toBe(true);
    expect(response.status).toBe(200);
    const events = parseNdjson(response.text);
    expect(events.at(-1)).toMatchObject({ type: 'done', item: { name: 'sample 2' } });
    expect(await fs.readdir(target)).toEqual(['theirs.txt']);
    expect(await fs.readFile(path.join(target, 'theirs.txt'))).toEqual(theirs);
    expect(await fs.readFile(path.join(workDir, 'sample 2', 'inside.txt'), 'utf8')).toBe('inside');

    // No record names their folder, so the next start leaves it where it is.
    expect(journalRecords()).toEqual([]);
    envContext.requireFresh('src/services/inFlightFiles').sweepInterrupted();
    expect(await fs.readFile(path.join(target, 'theirs.txt'))).toEqual(theirs);
  });

  /**
   * A new folder appears under its name only once the archive is whole in it.
   * Created first and extracted into, a failure removed it — and whatever
   * someone had put in it meanwhile — and a success merged into a folder that
   * appeared under the name during the extraction.
   */
  const extractingWith = (during) => {
    const archiveService = require(modulePath('src/services/archiveService'));
    vi.spyOn(archiveService, 'getSupportedArchiveExtensions').mockReturnValue(['zip']);
    vi.spyOn(archiveService, 'isSevenZipAvailable').mockResolvedValue(true);
    vi.spyOn(archiveService, 'readArchiveFootprint').mockResolvedValue(null);
    vi.spyOn(archiveService, 'extractArchive').mockImplementation(async (_archive, destination) => {
      await fs.writeFile(path.join(destination, 'inside.txt'), 'inside');
      await during();
    });
  };

  const archiveIn = async (directory) => {
    const workDir = path.join(envContext.volumeDir, directory);
    await fs.mkdir(workDir, { recursive: true });
    const zip = new AdmZip();
    zip.addFile('inside.txt', Buffer.from('inside'));
    zip.writeZip(path.join(workDir, 'sample.zip'));
    return workDir;
  };

  it('keeps what someone puts under the new folder’s name during an extraction that then fails', async () => {
    const workDir = await archiveIn('extract-fails');
    const target = path.join(workDir, 'sample');
    const theirs = Buffer.from('saved into the new folder meanwhile\n');
    extractingWith(async () => {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'theirs.txt'), theirs);
      throw Object.assign(new Error('The disk went away.'), { code: 'EIO' });
    });

    const response = await request(buildApp({ user: adminUser }))
      .post('/api/files/zip/extract')
      .send({ path: 'extract-fails/sample.zip' });

    expect(parseNdjson(response.text).at(-1)).toMatchObject({ type: 'error' });
    expect(await fs.readdir(target)).toEqual(['theirs.txt']);
    expect(await fs.readFile(path.join(target, 'theirs.txt'))).toEqual(theirs);
    expect((await fs.readdir(workDir)).sort()).toEqual(['sample', 'sample.zip']);
    expect(journalRecords()).toEqual([]);
  });

  it('puts the new folder beside one that appeared under its name during the extraction', async () => {
    const workDir = await archiveIn('extract-beside');
    const target = path.join(workDir, 'sample');
    const theirs = Buffer.from('put here by someone else\n');
    extractingWith(async () => {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'theirs.txt'), theirs);
    });

    const response = await request(buildApp({ user: adminUser }))
      .post('/api/files/zip/extract')
      .send({ path: 'extract-beside/sample.zip' });

    const events = parseNdjson(response.text);
    expect(events[0]).toMatchObject({ type: 'start', name: 'sample' });
    expect(events.at(-1)).toMatchObject({ type: 'done', item: { name: 'sample 2' } });
    expect(await fs.readdir(target)).toEqual(['theirs.txt']);
    expect(await fs.readFile(path.join(workDir, 'sample 2', 'inside.txt'), 'utf8')).toBe('inside');
    expect((await fs.readdir(workDir)).sort()).toEqual(['sample', 'sample 2', 'sample.zip']);
  });

  /**
   * An extraction into the current folder that fails after placing an entry
   * undoes what it placed. It used to remove the placed entries recursively,
   * taking a file someone had saved into a placed folder with them. It now
   * removes what it wrote, recognised by inode, and a folder only once empty.
   */
  const failAfterPlacingFolder = (intrude) => {
    const hooks = require(modulePath('src/services/folderSizeHooks'));
    vi.spyOn(hooks, 'onDirectoryTreeCreated').mockImplementation((placedFolder) => {
      intrude?.(placedFolder);
      throw Object.assign(new Error('The volume went read-only.'), { code: 'EROFS' });
    });
  };

  const archiveWithFolder = async (directory) => {
    const workDir = path.join(envContext.volumeDir, directory);
    await fs.mkdir(workDir, { recursive: true });
    const zip = new AdmZip();
    zip.addFile('photos/a.jpg', Buffer.from('a'));
    zip.addFile('photos/nested/b.jpg', Buffer.from('b'));
    zip.writeZip(path.join(workDir, 'sample.zip'));
    return workDir;
  };

  it('undoes a failed extraction into the current folder without removing what someone saved in it', async () => {
    const workDir = await archiveWithFolder('extract-undo-kept');
    const theirs = Buffer.from('saved into the placed folder meanwhile\n');
    failAfterPlacingFolder((placedFolder) =>
      fss.writeFileSync(path.join(placedFolder, 'nested', 'theirs.jpg'), theirs)
    );

    const response = await request(buildApp({ user: adminUser }))
      .post('/api/files/zip/extract')
      .send({ path: 'extract-undo-kept/sample.zip', destination: 'current' });

    expect(parseNdjson(response.text).at(-1)).toMatchObject({ type: 'error' });
    expect((await fs.readdir(workDir)).sort()).toEqual(['photos', 'sample.zip']);
    expect(await fs.readdir(path.join(workDir, 'photos'))).toEqual(['nested']);
    expect(await fs.readdir(path.join(workDir, 'photos', 'nested'))).toEqual(['theirs.jpg']);
    expect(await fs.readFile(path.join(workDir, 'photos', 'nested', 'theirs.jpg'))).toEqual(theirs);
  });

  it('undoes a failed extraction into the current folder entirely when nobody added anything', async () => {
    const workDir = await archiveWithFolder('extract-undo-whole');
    failAfterPlacingFolder();

    const response = await request(buildApp({ user: adminUser }))
      .post('/api/files/zip/extract')
      .send({ path: 'extract-undo-whole/sample.zip', destination: 'current' });

    expect(parseNdjson(response.text).at(-1)).toMatchObject({ type: 'error' });
    expect(await fs.readdir(workDir)).toEqual(['sample.zip']);
  });

  it('rejects formats the local build does not support', async () => {
    const workDir = path.join(envContext.volumeDir, 'archives-bad');
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, 'document.docx'), 'not really an archive');

    const app = buildApp({ user: adminUser });
    const response = await request(app)
      .post('/api/files/zip/extract')
      .send({ path: 'archives-bad/document.docx' });

    expect(response.status).toBe(400);
    expect(response.body?.error?.message || response.text).toMatch(/unsupported archive format/i);
  });

  it('compresses a selection into a zip, streaming its status', async () => {
    const workDir = path.join(envContext.volumeDir, 'to-compress');
    await fs.mkdir(path.join(workDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(workDir, 'a.txt'), 'alpha');
    await fs.writeFile(path.join(workDir, 'sub', 'b.txt'), 'beta');

    const app = buildApp({ user: adminUser });
    const response = await request(app)
      .post('/api/files/zip/compress')
      .send({
        items: [
          { name: 'a.txt', path: 'to-compress' },
          { name: 'sub', path: 'to-compress', kind: 'directory' },
        ],
        destination: 'to-compress',
        name: 'bundle',
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');

    const events = parseNdjson(response.text);
    expect(events[0]).toMatchObject({ type: 'start', name: 'bundle.zip' });
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.item?.name).toBe('bundle.zip');

    const entries = new AdmZip(path.join(workDir, 'bundle.zip'))
      .getEntries()
      .map((entry) => entry.entryName.replace(/\\/g, '/'));
    expect(entries).toContain('a.txt');
    expect(entries).toContain('sub/b.txt');
  });

  it('reports the supported formats from the 7-Zip probe', async () => {
    const archiveService = envContext.requireFresh('src/services/archiveService');
    const extensions = await archiveService.getSupportedArchiveExtensions();

    expect(Array.isArray(extensions)).toBe(true);
    // zip is always available: either through 7-Zip or the bundled fallback.
    expect(extensions).toContain('zip');
  });

  describe('ARCHIVE_EXTENSIONS configuration', () => {
    const loadConfigWithEnv = (value) => {
      const previous = process.env.ARCHIVE_EXTENSIONS;
      if (value === undefined) delete process.env.ARCHIVE_EXTENSIONS;
      else process.env.ARCHIVE_EXTENSIONS = value;
      clearModuleCache('src/config/env');
      clearModuleCache('src/config/index');
      const config = envContext.requireFresh('src/config/index');
      if (previous === undefined) delete process.env.ARCHIVE_EXTENSIONS;
      else process.env.ARCHIVE_EXTENSIONS = previous;
      return config;
    };

    it('uses the default whitelist when unset', () => {
      const { archives } = loadConfigWithEnv(undefined);
      expect(archives.extensions).toContain('iso');
      expect(archives.extensions).toContain('rar');
      expect(archives.extensions).toContain('zip');
    });

    it('replaces the whitelist with a plain list', () => {
      const { archives } = loadConfigWithEnv('zip, .ISO');
      expect(archives.extensions).toEqual(['zip', 'iso']);
    });

    it('extends the defaults with a leading +', () => {
      const { archives } = loadConfigWithEnv('+udf,squashfs');
      expect(archives.extensions).toContain('udf');
      expect(archives.extensions).toContain('squashfs');
      expect(archives.extensions).toContain('rar');
      expect(archives.extensions).toContain('zip');
    });
  });
});
