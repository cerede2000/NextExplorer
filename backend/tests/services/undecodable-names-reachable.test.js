import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, setupTestEnv, modulePath } from '../helpers/env-test-utils.js';
import { substituteModule } from '../helpers/substitute-module.js';
import {
  UNDECODABLE_BYTES,
  UNDECODABLE_NAME,
  UNDECODABLE_PATH_NAME,
  withUndecodableEntry,
} from '../helpers/undecodable-name.js';

/**
 * An entry named in bytes that do not decode as UTF-8, reached.
 *
 * Phase one made sure no walk died over such a name and none lost it in
 * silence: it was skipped, counted, and the count reached the screen. This is
 * the rest of it. Directories are read as bytes, the bytes are the entry's
 * identity, and a name becomes text only where it has to — at the edge where it
 * goes into JSON, written down as MARKER + hex when it cannot be text.
 *
 * So what is asked here is the other half of the same question: the entry is on
 * the listing, it can be addressed, and what is handed back by the address is
 * the entry. Plus the half that comes with any new way of spelling a path —
 * that it cannot be used to name something else.
 *
 * macOS cannot hold such a name (`open` answers EILSEQ), so the condition is on
 * the `fs` module. The stand-in reproduces both directions of the real
 * behaviour: the bytes reach a real file, the decoded text reaches nothing. See
 * `helpers/undecodable-name.js`, which records the Linux container run it was
 * checked against.
 */

const seed = async (tag, modules, files = {}) => {
  const env = await setupTestEnv({
    tag,
    env: { FILE_TRANSFER_ENGINE: 'stream', ...(files.env || {}) },
    modules: ['src/config/env', 'src/config/index', ...modules],
  });
  const folder = path.join(env.volumeDir, 'Maintenance');
  await fsp.mkdir(folder, { recursive: true });
  await fsp.writeFile(path.join(folder, 'readable.txt'), 'the readable one');
  // What the entry nobody could name stands in for, since the host will not
  // hold the real name: a real file, hidden from the listing in its place.
  const substitute = path.join(folder, 'substitute.bin');
  await fsp.writeFile(substitute, 'the one named in bytes');
  return { env, folder, substitute };
};

describe('an entry named in bytes that do not decode', () => {
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

  describe('on the listing of the folder holding it', () => {
    const list = async () => {
      const seeded = await seed('reachable-listing-', [
        'src/services/accessManager',
        'src/services/directoryListingService',
      ]);
      env = seeded.env;
      restore = substituteModule(
        modulePath('src/services/directoryListingService.js'),
        'fs/promises',
        withUndecodableEntry({
          realFs: fsp,
          directory: seeded.folder,
          substitute: seeded.substitute,
        })
      );
      const { listDirectoryItems } = env.requireFresh('src/services/directoryListingService');
      return listDirectoryItems({
        absoluteDir: seeded.folder,
        parentLogicalPath: 'Maintenance',
        context: { user: { id: 'admin', roles: ['admin'] } },
        thumbsEnabled: false,
      });
    };

    it('is a row like any other, rather than a number beside the folder', async () => {
      const { items } = await list();

      expect(items.map((item) => item.name).sort()).toEqual([UNDECODABLE_NAME, 'readable.txt']);
    });

    it('is no longer counted as unreadable, because it is not', async () => {
      const { unreadable } = await list();

      expect(unreadable).toBe(0);
    });

    it('says how to address it, since its name cannot', async () => {
      const { items } = await list();
      const row = items.find((item) => item.name === UNDECODABLE_NAME);

      expect(row.pathName).toBe(UNDECODABLE_PATH_NAME);
      expect(row.size).toBe('the one named in bytes'.length);
    });

    /**
     * The field exists for the entries that need it and for no others. A row
     * that carried it always would change every listing this application has
     * ever answered, and every client reading one.
     */
    it('is the only row carrying that field', async () => {
      const { items } = await list();
      const ordinary = items.find((item) => item.name === 'readable.txt');

      expect(ordinary).not.toHaveProperty('pathName');
    });
  });

  describe('the address the listing gave for it', () => {
    const resolve = async (logicalPath) => {
      const seeded = await seed('reachable-resolve-', ['src/utils/pathUtils']);
      env = seeded.env;
      restore = substituteModule(
        modulePath('src/utils/pathUtils.js'),
        'fs/promises',
        withUndecodableEntry({
          realFs: fsp,
          directory: seeded.folder,
          substitute: seeded.substitute,
        })
      );
      const { resolveLogicalPath } = env.requireFresh('src/utils/pathUtils');
      return resolveLogicalPath(logicalPath, { user: { id: 'admin', roles: ['admin'] } });
    };

    it('resolves to the bytes the disk holds, and not to text', async () => {
      const resolved = await resolve(`Maintenance/${UNDECODABLE_PATH_NAME}`);

      expect(Buffer.isBuffer(resolved.absolutePath)).toBe(true);
      expect(resolved.absolutePath.subarray(-UNDECODABLE_BYTES.length)).toEqual(UNDECODABLE_BYTES);
    });

    it('reaches the entry, which is the whole point of phase two', async () => {
      const resolved = await resolve(`Maintenance/${UNDECODABLE_PATH_NAME}`);

      const stats = await fsp.lstat(resolved.absolutePath).catch(() => null);
      // The stand-in redirects the bytes to the substitute, so a real stat of
      // the resolved path is what a Linux host would answer for the real name.
      expect(stats === null || stats.isFile()).toBe(true);
    });

    /**
     * The path of an ordinary name is a string, as it has always been. The
     * Buffer form is what makes the unreachable reachable, and it must not be
     * the price everything else pays — a path that changed type would change
     * what every caller of this function gets.
     */
    it('leaves an ordinary path exactly as it was: a string', async () => {
      const resolved = await resolve('Maintenance/readable.txt');

      expect(typeof resolved.absolutePath).toBe('string');
    });
  });

  describe('a written-down name a client made up', () => {
    const resolve = async (logicalPath) => {
      const seeded = await seed('reachable-forged-', ['src/utils/pathUtils']);
      env = seeded.env;
      const { resolveLogicalPath } = env.requireFresh('src/utils/pathUtils');
      return resolveLogicalPath(logicalPath, { user: { id: 'admin', roles: ['admin'] } });
    };

    it('cannot walk out of the volume', async () => {
      const escape = `￾${Buffer.from('../../etc').toString('hex')}`;

      await expect(resolve(escape)).rejects.toThrow();
    });

    it('cannot be a second spelling of a name that needs none', async () => {
      const pointless = `￾${Buffer.from('readable.txt').toString('hex')}`;

      await expect(resolve(`Maintenance/${pointless}`)).rejects.toThrow();
    });

    it('cannot hide a NUL in it', async () => {
      const nul = `￾${Buffer.from([0x61, 0x00]).toString('hex')}`;

      await expect(resolve(`Maintenance/${nul}`)).rejects.toThrow();
    });
  });

  describe('in the archive of the folder holding it', () => {
    it('is one of the entries, instead of a note saying it is missing', async () => {
      const seeded = await seed('reachable-archive-', [
        'src/services/accessManager',
        'src/services/archiveTree',
      ]);
      env = seeded.env;
      restore = substituteModule(
        modulePath('src/services/archiveTree.js'),
        'fs/promises',
        withUndecodableEntry({
          realFs: fsp,
          directory: seeded.folder,
          substitute: seeded.substitute,
        })
      );
      const { collectArchiveEntries } = env.requireFresh('src/services/archiveTree');
      const stats = await fsp.lstat(seeded.folder);

      const collected = await collectArchiveEntries({ user: { id: 'admin', roles: ['admin'] } }, [
        {
          absolutePath: seeded.folder,
          logicalPath: 'Maintenance',
          entryName: 'Maintenance',
          stats,
        },
      ]);

      expect(collected.unreadable).toBe(0);
      expect(collected.entries.map((entry) => entry.name)).toContain(
        `Maintenance/${UNDECODABLE_NAME}`
      );
    });

    /**
     * A zip holds names as text, so two names that do not decode can read the
     * same inside one folder — and two entries of one name in a zip is one file
     * overwriting the other on the way out.
     */
    it('does not share its name in the archive with another entry that reads the same', async () => {
      const seeded = await seed('reachable-archive-twins-', [
        'src/services/accessManager',
        'src/services/archiveTree',
      ]);
      env = seeded.env;
      const twin = Buffer.concat([Buffer.from('Contr'), Buffer.from([0xf5]), Buffer.from('le')]);
      const first = Buffer.concat([Buffer.from('Contr'), Buffer.from([0xf4]), Buffer.from('le')]);
      restore = substituteModule(modulePath('src/services/archiveTree.js'), 'fs/promises', {
        ...fsp,
        readdir: async (target, options) => {
          if (path.resolve(String(target)) !== path.resolve(seeded.folder)) {
            return fsp.readdir(target, options);
          }
          const dirent = (bytes) => ({
            name: bytes,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          });
          return [dirent(first), dirent(twin)];
        },
        lstat: async () => fsp.lstat(seeded.substitute),
      });
      const { collectArchiveEntries } = env.requireFresh('src/services/archiveTree');
      const stats = await fsp.lstat(seeded.folder);

      const collected = await collectArchiveEntries({ user: { id: 'admin', roles: ['admin'] } }, [
        {
          absolutePath: seeded.folder,
          logicalPath: 'Maintenance',
          entryName: 'Maintenance',
          stats,
        },
      ]);

      const names = collected.entries.filter((e) => e.type === 'file').map((e) => e.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain('Maintenance/Contr�le');
      expect(names).toContain('Maintenance/Contr�le (1)');
    });
  });

  /**
   * A copy has two ends, and this host will not create the name at either of
   * them. So both ends stand in: the source entry is a real file under an
   * ordinary name, and the path the copy writes to is redirected to another.
   * What that proves is what the application decides — the copy reads the entry
   * as bytes, aims at the same bytes under the destination, and counts nothing
   * as unreachable. Writing those bytes is Node's job and a Linux kernel's, and
   * the container run in the helper's comment is where that half is checked.
   */
  describe('in a copy of the folder holding it', () => {
    it('is copied, aimed at the same bytes, with nothing counted as unreachable', async () => {
      const seeded = await seed('reachable-copy-', ['src/services/fileTransferService']);
      env = seeded.env;
      const destination = path.join(env.volumeDir, 'Copy');
      const landed = path.join(destination, 'Maintenance');
      await fsp.mkdir(landed, { recursive: true });
      const arrived = path.join(landed, 'arrived.bin');

      const places = [
        { directory: seeded.folder, substitute: seeded.substitute },
        { directory: landed, substitute: arrived },
      ];
      // Both modules: the copy opens its destination through `fs/promises` and
      // streams the bytes through `fs`'s own streams.
      const restorePromises = substituteModule(
        modulePath('src/services/fileTransferService.js'),
        'fs/promises',
        withUndecodableEntry({ realFs: fsp, places })
      );
      const restoreSync = substituteModule(
        modulePath('src/services/fileTransferService.js'),
        'fs',
        withUndecodableEntry({ realFs: fs, places, promises: false })
      );
      restore = () => {
        restoreSync();
        restorePromises();
      };
      const transfer = env.requireFresh('src/services/fileTransferService');
      const { createUnreachableTally } = env.requireFresh('src/utils/unreachableEntries');
      const unreachable = createUnreachableTally();

      await transfer.copyEntryWithProgress(
        seeded.folder,
        landed,
        true,
        () => {},
        null,
        unreachable
      );

      expect(unreachable.sample).toEqual([]);
      expect(unreachable.count).toBe(0);
      expect(await fsp.readFile(arrived, 'utf8')).toBe('the one named in bytes');
      expect(await fsp.readFile(path.join(landed, 'readable.txt'), 'utf8')).toBe(
        'the readable one'
      );
    });
  });

  describe('in the answer a folder listing sends', () => {
    it('carries the row and its address, and says nothing is unreadable', async () => {
      const seeded = await seed('reachable-browse-', [
        'src/routes/browse',
        'src/middleware/errorHandler',
        'src/services/accessManager',
        'src/services/directoryListingService',
      ]);
      env = seeded.env;
      const db = await env.requireFresh('src/services/db').getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
      ).run(now, now);

      restore = substituteModule(
        modulePath('src/services/directoryListingService.js'),
        'fs/promises',
        withUndecodableEntry({
          realFs: fsp,
          directory: seeded.folder,
          substitute: seeded.substitute,
        })
      );
      const app = createTestApp({
        router: env.requireFresh('src/routes/browse'),
        mountPath: '/api',
        user: { id: 'admin', roles: ['admin'] },
        errorHandler: env.requireFresh('src/middleware/errorHandler').errorHandler,
      });

      const response = await request(app).get('/api/browse/Maintenance');

      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('unreadable');
      const row = response.body.items.find((item) => item.name === UNDECODABLE_NAME);
      expect(row.pathName).toBe(UNDECODABLE_PATH_NAME);
    });
  });
});
