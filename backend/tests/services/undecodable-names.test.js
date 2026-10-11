import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, setupTestEnv, modulePath } from '../helpers/env-test-utils.js';
import { substituteModule } from '../helpers/substitute-module.js';
import { withUndecodableEntry } from '../helpers/undecodable-name.js';

/**
 * A folder holding a name nothing can open, and what each walk does with it.
 *
 * The defect: a name on disk is bytes, `readdir` answers with text, and Node
 * puts U+FFFD where those bytes do not decode as UTF-8. That character
 * re-encodes to three bytes where the disk holds one, so the path built back
 * from the name leads nowhere and `lstat` answers ENOENT for a file that is
 * plainly there. A volume carried over from Windows is full of such names —
 * `Contrôle`, whose `ô` is the single byte 0xF4.
 *
 * macOS, where this suite runs, refuses to create such a name at all, so the
 * condition is put on the `fs` module rather than on the disk. See
 * `helpers/undecodable-name.js`, which records the Linux container run it was
 * checked against; everything else here is a real file in a real temporary
 * directory.
 *
 * What is asserted is the decision rather than the mechanism: no walk dies over
 * such an entry, and no walk loses it in silence. The second half is the one
 * that matters. An archive missing files, handed over as the folder, is a
 * backup that lies, and that is worse than the 500 this used to answer.
 */

/**
 * `FILE_TRANSFER_ENGINE: 'stream'` because the engine decides whether there is
 * anything to decide.
 *
 * `nativeTransferEnabled()` is true by default on Linux, and rsync copies a
 * directory whole without ever turning a name into text — so on the CI runner a
 * copy of such a folder is complete and has nothing to report, exactly as 7-Zip
 * does for an archive. The walk in JavaScript is the one that reads names, so it
 * is the one these tests ask. Left to the host, the same test would check the
 * stream engine on this Mac (whose rsync is too old for the native path anyway)
 * and the rsync engine in CI, which is two different questions under one name.
 */
const context = async (tag, modules) =>
  setupTestEnv({
    tag,
    env: { FILE_TRANSFER_ENGINE: 'stream' },
    modules: ['src/config/env', 'src/config/index', ...modules],
  });

describe('an entry whose name cannot be decoded', () => {
  let env;
  let restore;

  afterEach(async () => {
    restore?.();
    restore = null;
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('in the listing of the folder holding it', () => {
    const list = async () => {
      env = await context('undecodable-listing-', [
        'src/services/accessManager',
        'src/services/directoryListingService',
      ]);
      const folder = path.join(env.volumeDir, 'Maintenance');
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, 'readable.txt'), 'here');

      restore = substituteModule(
        modulePath('src/services/directoryListingService.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: folder })
      );

      const { listDirectoryItems } = env.requireFresh('src/services/directoryListingService');
      return listDirectoryItems({
        absoluteDir: folder,
        parentLogicalPath: 'Maintenance',
        context: { user: { id: 'admin', roles: ['admin'] } },
        thumbsEnabled: false,
      });
    };

    it('leaves it off the rows, since no action through such a row could work', async () => {
      const { items } = await list();

      expect(items.map((item) => item.name)).toEqual(['readable.txt']);
    });

    it('says how many rows are missing instead of just being short of one', async () => {
      const { unreadable } = await list();

      expect(unreadable).toBe(1);
    });
  });

  describe('in the walk an archive of a folder is built from', () => {
    const collect = async () => {
      env = await context('undecodable-archive-', [
        'src/services/accessManager',
        'src/services/archiveTree',
      ]);
      const folder = path.join(env.volumeDir, 'Maintenance');
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, 'readable.txt'), 'here');

      restore = substituteModule(
        modulePath('src/services/archiveTree.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: folder })
      );

      const { collectArchiveEntries } = env.requireFresh('src/services/archiveTree');
      const stats = await fsp.lstat(folder);
      return collectArchiveEntries({ user: { id: 'admin', roles: ['admin'] } }, [
        { absolutePath: folder, logicalPath: 'Maintenance', entryName: 'Maintenance', stats },
      ]);
    };

    it('does not fail the whole archive over one name', async () => {
      const { entries } = await collect();

      expect(entries.map((entry) => entry.name)).toContain('Maintenance/readable.txt');
    });

    it('counts it apart from what an access rule deliberately leaves out', async () => {
      const collected = await collect();

      expect(collected.unreadable).toBe(1);
      expect(collected.excluded).toBe(0);
    });

    it('puts a note in the archive, which is the only channel a download has', async () => {
      const collected = await collect();
      const { unreadableNotice } = env.requireFresh('src/services/archiveTree');

      const notice = unreadableNotice(collected);

      expect(notice.name).toBe('UNREADABLE-ENTRIES.txt');
      expect(notice.body).toContain('1 entry could not be read');
      expect(notice.body).toContain('convmv');
    });

    it('takes a free name for that note, so no archive holds two of one name', async () => {
      env = await context('undecodable-notice-', ['src/services/archiveTree']);
      const { unreadableNotice } = env.requireFresh('src/services/archiveTree');

      const notice = unreadableNotice({
        unreadable: 2,
        unreadableSample: [],
        entries: [{ name: 'UNREADABLE-ENTRIES.txt' }],
      });

      expect(notice.name).toBe('UNREADABLE-ENTRIES (1).txt');
    });

    it('says nothing when the folder was read whole', async () => {
      env = await context('undecodable-notice-none-', ['src/services/archiveTree']);
      const { unreadableNotice } = env.requireFresh('src/services/archiveTree');

      expect(unreadableNotice({ unreadable: 0, entries: [] })).toBeNull();
    });
  });

  /**
   * The archive itself is the only channel the download of a folder has.
   *
   * It is taken by submitting a form, which is a navigation: nothing in the
   * page sees the response, so a JSON field or a header would reach nobody.
   * Whoever opens the zip — today, or in a year looking for a file that was
   * supposed to be in it — reads the note. The header is there for the one way
   * of downloading that does fetch, writing each part into a folder the reader
   * picked.
   */
  describe('in the archive a folder is downloaded as', () => {
    const download = async () => {
      env = await setupTestEnv({
        tag: 'undecodable-download-',
        env: {},
        modules: [
          'src/config/env',
          'src/config/index',
          'src/routes/files/download',
          'src/middleware/errorHandler',
          'src/services/accessManager',
          'src/services/archiveTree',
        ],
      });
      const db = await env.requireFresh('src/services/db').getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
      ).run(now, now);

      const folder = path.join(env.volumeDir, 'Maintenance');
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, 'readable.txt'), 'here');

      restore = substituteModule(
        modulePath('src/services/archiveTree.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: folder })
      );

      const app = createTestApp({
        router: env.requireFresh('src/routes/files/download'),
        mountPath: '/api',
        user: { id: 'admin', roles: ['admin'] },
        errorHandler: env.requireFresh('src/middleware/errorHandler').errorHandler,
      });

      return request(app)
        .post('/api/download')
        .send({ items: ['Maintenance'], basePath: '' })
        .buffer()
        .parse((res, callback) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });
    };

    it('answers the archive rather than 500', async () => {
      const response = await download();

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('zip');
    });

    it('carries a note inside it saying what is missing', async () => {
      const response = await download();

      // Read as bytes rather than unzipped: a zip stores each entry's name in
      // the clear, which is all this has to find.
      const archive = response.body.toString('latin1');
      expect(archive).toContain('UNREADABLE-ENTRIES.txt');
      expect(archive).toContain('Maintenance/readable.txt');
    });

    it('says the count in a header, for whoever fetches it', async () => {
      const response = await download();

      expect(response.headers['x-unreadable-entries']).toBe('1');
    });

    it('says nothing when the folder was read whole', async () => {
      env = await setupTestEnv({
        tag: 'undecodable-download-clean-',
        env: {},
        modules: [
          'src/config/env',
          'src/config/index',
          'src/routes/files/download',
          'src/middleware/errorHandler',
          'src/services/accessManager',
        ],
      });
      const db = await env.requireFresh('src/services/db').getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
      ).run(now, now);
      const folder = path.join(env.volumeDir, 'Maintenance');
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, 'readable.txt'), 'here');

      const app = createTestApp({
        router: env.requireFresh('src/routes/files/download'),
        mountPath: '/api',
        user: { id: 'admin', roles: ['admin'] },
        errorHandler: env.requireFresh('src/middleware/errorHandler').errorHandler,
      });

      const response = await request(app)
        .post('/api/download')
        .send({ items: ['Maintenance'], basePath: '' })
        .buffer()
        .parse((res, callback) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(response.headers['x-unreadable-entries']).toBeUndefined();
      expect(response.body.toString('latin1')).not.toContain('UNREADABLE-ENTRIES');
    });
  });

  describe('in a copy of the folder holding it', () => {
    const copy = async () => {
      env = await context('undecodable-copy-', ['src/services/fileTransferService']);
      const source = path.join(env.volumeDir, 'Maintenance');
      const destination = path.join(env.volumeDir, 'Copy');
      await fsp.mkdir(source, { recursive: true });
      await fsp.mkdir(destination, { recursive: true });
      await fsp.writeFile(path.join(source, 'readable.txt'), 'here');

      restore = substituteModule(
        modulePath('src/services/fileTransferService.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: source })
      );

      const transfer = env.requireFresh('src/services/fileTransferService');
      const { createUnreachableTally } = env.requireFresh('src/utils/unreachableEntries');
      const unreachable = createUnreachableTally();
      const landed = path.join(destination, 'Maintenance');
      await transfer.copyEntryWithProgress(source, landed, true, () => {}, null, unreachable);
      return { landed, unreachable };
    };

    it('copies what it can reach rather than failing over what it cannot', async () => {
      const { landed } = await copy();

      expect(await fsp.readdir(landed)).toEqual(['readable.txt']);
    });

    it('counts what it left behind, so the copy is never reported as whole', async () => {
      const { unreachable } = await copy();

      expect(unreachable.count).toBe(1);
    });

    it('still fails when the caller asked for no count, rather than quietly skipping', async () => {
      const { landed } = await copy();
      restore?.();
      restore = null;
      await fsp.rm(landed, { recursive: true, force: true });

      const source = path.join(env.volumeDir, 'Maintenance');
      restore = substituteModule(
        modulePath('src/services/fileTransferService.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: source })
      );
      const transfer = env.requireFresh('src/services/fileTransferService');

      await expect(
        transfer.copyEntryWithProgress(source, landed, true, () => {}, null)
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  /**
   * The one place where skipping would destroy something.
   *
   * A move across disks copies, then removes the source — and `rm -r` removes a
   * name this copy could not read, because it never decodes one. So a move that
   * skipped an entry and went on would delete the only copy of it while
   * reporting the move as done. The source stays instead, and the answer says
   * both things: how many entries could not be read, and that the original is
   * still there.
   */
  describe('in a move of the folder holding it', () => {
    const move = async () => {
      env = await setupTestEnv({
        tag: 'undecodable-move-',
        env: { FILE_TRANSFER_ENGINE: 'stream', FOLDER_SIZE_MODE: 'off' },
      });
      const db = await env.requireFresh('src/services/db').getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
      ).run(now, now);

      const source = path.join(env.volumeDir, 'From', 'Maintenance');
      await fsp.mkdir(source, { recursive: true });
      await fsp.mkdir(path.join(env.volumeDir, 'To'), { recursive: true });
      await fsp.writeFile(path.join(source, 'readable.txt'), 'here');

      // A move on one filesystem is a rename, and a rename never looks at the
      // names inside: the copy is the path with something to decide, and EXDEV
      // is what sends a move down it. Only this one folder's rename answers
      // EXDEV — the one that puts the finished copy under its name has to
      // work, and this suite has no second device to borrow (`REQUIRE_CROSS_DEVICE`
      // covers the trash's own cross-device rules on Linux).
      const wrapped = withUndecodableEntry({ realFs: fsp, directory: source });
      restore = substituteModule(modulePath('src/services/fileTransferService.js'), 'fs/promises', {
        ...wrapped,
        rename: async (from, to) => {
          if (path.resolve(from) === source) {
            throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
          }
          return wrapped.rename(from, to);
        },
      });

      const service = env.requireFresh('src/services/fileTransferService');
      const prep = await service.prepareTransfer([{ path: 'From/Maintenance' }], 'To', 'move', {
        user: { id: 'admin', roles: ['admin'] },
      });
      const result = await service.executeTransfer(prep, 'move', () => {});
      return { result, source };
    };

    it('leaves the original where it is, since it holds the only copy', async () => {
      const { source } = await move();

      expect(await fsp.readdir(source)).toEqual(['readable.txt']);
    });

    it('says the move kept its source, rather than reporting it as done', async () => {
      const { result } = await move();

      expect(result.items[0]).toMatchObject({ sourceKept: true, unreadable: 1 });
    });

    it('answers one count for the whole transfer', async () => {
      const { result } = await move();

      expect(result.unreadable).toBe(1);
    });
  });

  /**
   * Restoring from the trash is the other place where skipping would destroy
   * something: the trash's copy is removed once the new one is whole. So this
   * walk refuses rather than skips — the item stays in the trash, nothing is
   * lost, and the message says what happened instead of the bare ENOENT for a
   * file plainly there that it used to answer.
   */
  describe('in a restore from the trash', () => {
    it('refuses, saying what it could not read, instead of copying part of it', async () => {
      env = await context('undecodable-restore-', [
        'src/services/fileTransferService',
        'src/services/trash/operations',
      ]);
      const source = path.join(env.volumeDir, 'Deleted');
      const destination = path.join(env.volumeDir, 'Back');
      await fsp.mkdir(source, { recursive: true });
      await fsp.writeFile(path.join(source, 'readable.txt'), 'here');

      restore = substituteModule(
        modulePath('src/services/fileTransferService.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: source })
      );
      const { copyTree } = env.requireFresh('src/services/trash/operations');

      await expect(copyTree(source, destination, true, null, null)).rejects.toMatchObject({
        code: 'UNREADABLE_ENTRIES',
        unreadable: 1,
      });
    });
  });

  describe('in the inventory an extraction is undone by', () => {
    it('is walked past instead of throwing, which used to fail the extraction', async () => {
      env = await context('undecodable-inventory-', ['src/utils/ownedTree']);
      const staging = path.join(env.volumeDir, 'staging');
      await fsp.mkdir(staging, { recursive: true });
      await fsp.writeFile(path.join(staging, 'readable.txt'), 'here');

      restore = substituteModule(
        modulePath('src/utils/ownedTree.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: staging })
      );
      const { takeInventory } = env.requireFresh('src/utils/ownedTree');

      await expect(takeInventory(staging)).resolves.toBeInstanceOf(Set);
    });

    /**
     * The other half of the same walk: a folder the undo cannot look inside.
     *
     * Not the undecodable entry itself — an ENOENT for one of those is
     * indistinguishable from an entry that simply went, and either way nothing
     * is removed, which is the safe answer. What this asks about is the folder
     * holding one: it used to throw mid-undo, leaving the rest of what the
     * operation wrote behind with nothing said. Now it is kept and reported as
     * kept, because as far as anybody here can tell it is not empty.
     */
    it('keeps a folder it cannot look inside, and says it kept it', async () => {
      env = await context('undecodable-undo-', ['src/utils/ownedTree']);
      const placed = path.join(env.volumeDir, 'placed');
      const opaque = path.join(placed, 'opaque');
      await fsp.mkdir(opaque, { recursive: true });
      await fsp.writeFile(path.join(placed, 'written.txt'), 'here');

      const inventory = await env.requireFresh('src/utils/ownedTree').takeInventory(placed);

      restore = substituteModule(modulePath('src/utils/ownedTree.js'), 'fs/promises', {
        ...fsp,
        readdir: async (target, options) => {
          if (path.resolve(target) === opaque) {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          }
          return fsp.readdir(target, options);
        },
      });
      const { removeInventoried } = env.requireFresh('src/utils/ownedTree');

      const kept = await removeInventoried(placed, inventory);

      expect(kept).toEqual([opaque]);
      expect(await fsp.readdir(placed)).toEqual(['opaque']);
    });
  });

  /**
   * The count has to leave the service and reach the answer, or the screen can
   * never say it. The description of the API is kept in step by
   * `tests/openapi/responses-match-description.test.js`, which refuses a field
   * nobody wrote down.
   */
  describe('in the answer a folder listing sends', () => {
    it('carries the count to the caller', async () => {
      env = await setupTestEnv({
        tag: 'undecodable-browse-',
        env: {},
        modules: [
          'src/config/env',
          'src/config/index',
          'src/routes/browse',
          'src/middleware/errorHandler',
          'src/services/accessManager',
          'src/services/directoryListingService',
        ],
      });
      const db = await env.requireFresh('src/services/db').getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
      ).run(now, now);

      const folder = path.join(env.volumeDir, 'Maintenance');
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, 'readable.txt'), 'here');

      restore = substituteModule(
        modulePath('src/services/directoryListingService.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: folder })
      );

      const app = createTestApp({
        router: env.requireFresh('src/routes/browse'),
        mountPath: '/api',
        user: { id: 'admin', roles: ['admin'] },
        errorHandler: env.requireFresh('src/middleware/errorHandler').errorHandler,
      });

      const response = await request(app).get('/api/browse/Maintenance');

      expect(response.status).toBe(200);
      expect(response.body.items.map((item) => item.name)).toEqual(['readable.txt']);
      expect(response.body.unreadable).toBe(1);
    });

    it('says nothing when every entry was reached', async () => {
      env = await setupTestEnv({
        tag: 'undecodable-browse-clean-',
        env: {},
        modules: [
          'src/config/env',
          'src/config/index',
          'src/routes/browse',
          'src/middleware/errorHandler',
          'src/services/accessManager',
          'src/services/directoryListingService',
        ],
      });
      const db = await env.requireFresh('src/services/db').getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
      ).run(now, now);
      await fsp.writeFile(path.join(env.volumeDir, 'readable.txt'), 'here');

      const app = createTestApp({
        router: env.requireFresh('src/routes/browse'),
        mountPath: '/api',
        user: { id: 'admin', roles: ['admin'] },
        errorHandler: env.requireFresh('src/middleware/errorHandler').errorHandler,
      });

      const response = await request(app).get('/api/browse/');

      expect(response.body).not.toHaveProperty('unreadable');
    });
  });

  describe('in an extraction that wrote it to its staging folder', () => {
    it('places what it can and answers how many it could not', async () => {
      env = await context('undecodable-extract-', [
        'src/services/archiveExtraction',
        'src/utils/ownedTree',
      ]);
      const staging = path.join(env.volumeDir, '.staging');
      const destination = path.join(env.volumeDir, 'Here');
      await fsp.mkdir(staging, { recursive: true });
      await fsp.mkdir(destination, { recursive: true });
      await fsp.writeFile(path.join(staging, 'readable.txt'), 'here');

      const undecodable = withUndecodableEntry({ realFs: fsp, directory: staging });
      restore = substituteModule(
        modulePath('src/services/archiveExtraction.js'),
        'fs/promises',
        undecodable
      );
      const restoreTree = substituteModule(
        modulePath('src/utils/ownedTree.js'),
        'fs/promises',
        undecodable
      );
      const { extractIntoCurrentFolder } = env.requireFresh('src/services/archiveExtraction');

      try {
        const outcome = await extractIntoCurrentFolder({
          stagingDirectory: staging,
          destinationDirectory: destination,
          relativeParentPath: 'Here',
          movedPaths: [],
        });

        expect(outcome.items.map((item) => item.name)).toEqual(['readable.txt']);
        expect(outcome.unreadable).toBe(1);
      } finally {
        restoreTree();
      }
    });
  });

  describe('in the figures a folder reports for its properties', () => {
    it('answers what it could reach and says how many it could not', async () => {
      env = await context('undecodable-properties-', ['src/routes/metadata']);
      const folder = path.join(env.volumeDir, 'Maintenance');
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, 'readable.txt'), 'here');

      restore = substituteModule(
        modulePath('src/routes/metadata.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: folder })
      );
      const { sumDirectory } = env.requireFresh('src/routes/metadata');

      const summary = await sumDirectory(folder);

      expect(summary.fileCount).toBe(1);
      expect(summary.unreadable).toBe(1);
    });
  });

  /**
   * The two background walks. Neither of them ever died over such a name, and
   * that was the problem: one left the file out of the index, the other left
   * its bytes out of a folder's size, and both reported a number that looked
   * complete. The count is what says the number is short.
   */
  describe('in the walk that builds the search index', () => {
    it('reports the files it could not open, apart from the ones it chose not to read', async () => {
      env = await setupTestEnv({ tag: 'undecodable-search-index-', env: {} });
      const db = await env.requireFresh('src/services/indexDb').getIndexDb();
      const folder = path.join(env.volumeDir, 'Maintenance');
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, 'readable.md'), 'something to find');

      restore = substituteModule(
        modulePath('src/services/searchIndexer.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: folder })
      );
      const indexer = env.requireFresh('src/services/searchIndexer');

      const report = await indexer.indexTree({ db, rootAbs: env.volumeDir, cpuPercent: 100 });

      expect(report.indexed).toBe(1);
      expect(report.unreadable).toBe(1);
    });
  });

  describe('in the walk that measures folder sizes', () => {
    it('reports the files whose size it could not ask for', async () => {
      env = await setupTestEnv({
        tag: 'undecodable-folder-size-',
        env: { FOLDER_SIZE_MODE: 'full' },
      });
      const db = await env.requireFresh('src/services/indexDb').getIndexDb();
      const folder = path.join(env.volumeDir, 'Maintenance');
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, 'readable.txt'), 'here');

      restore = substituteModule(
        modulePath('src/services/folderSizeIndexer.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: folder })
      );
      const indexer = env.requireFresh('src/services/folderSizeIndexer');

      const report = await indexer.runBaseline(db, { root: env.volumeDir, label: 'volume' });

      // Four bytes for `here`, and nothing for the entry it could not ask
      // about: the total is short, and the count is what says by how much.
      expect(report.bytes).toBe(4);
      expect(report.unreadable).toBe(1);
    });
  });

  describe('in the check that no archive brought a symbolic link', () => {
    it('is refused rather than passed as a subtree nobody looked into', async () => {
      env = await context('undecodable-symlink-guard-', ['src/services/archiveService']);
      const staging = path.join(env.volumeDir, 'staging');
      await fsp.mkdir(path.join(staging, 'inner'), { recursive: true });

      restore = substituteModule(
        modulePath('src/services/archiveService.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, directory: staging, isDirectory: true })
      );
      const { assertNoSymlinks } = env.requireFresh('src/services/archiveService');

      await expect(assertNoSymlinks(staging)).rejects.toMatchObject({
        code: 'ARCHIVE_NOT_INSPECTABLE',
      });
    });
  });
});
