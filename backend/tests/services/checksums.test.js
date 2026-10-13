import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What a file's bytes add up to, computed once and remembered.
 *
 * The remembering is the part that can go wrong in a way nobody notices: a
 * stored hash of a file that has since changed answers confidently and answers
 * wrong. Clearing it wherever the application writes is the version that cannot
 * be made to hold — the writer that gets forgotten is the one nobody thinks of,
 * and a file changed over SMB or from a shell is nobody's write at all. So what
 * these hold is that the file's own state is the key, and that a file which
 * changed by any route never finds its row.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const setup = async () => {
  envContext = await setupTestEnv({ tag: 'checksums-' });
  return {
    checksums: envContext.requireFresh('src/services/checksums'),
    volume: envContext.volumeDir,
  };
};

const digestOf = (algorithm, text) => crypto.createHash(algorithm).update(text).digest('hex');

const write = async (absolutePath, text) => {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, text);
  return absolutePath;
};

/** A later write with a later timestamp, whatever the clock's resolution. */
const rewrite = async (absolutePath, text) => {
  await fs.writeFile(absolutePath, text);
  const later = new Date(Date.now() + 2000);
  await fs.utimes(absolutePath, later, later);
};

describe('the digests of a file', () => {
  it('are what its bytes give, all of them in one reading', async () => {
    const { checksums, volume } = await setup();
    const file = await write(path.join(volume, 'report.txt'), 'quarterly figures');

    const { digests, size } = await checksums.digestsOf({ absolutePath: file });

    expect(digests).toEqual({
      md5: digestOf('md5', 'quarterly figures'),
      sha1: digestOf('sha1', 'quarterly figures'),
      sha256: digestOf('sha256', 'quarterly figures'),
    });
    expect(size).toBe('quarterly figures'.length);
  });

  it('are read once and remembered', async () => {
    const { checksums, volume } = await setup();
    const file = await write(path.join(volume, 'report.txt'), 'quarterly figures');
    const asked = { absolutePath: file };

    const first = await checksums.digestsOf(asked);
    const second = await checksums.digestsOf(asked);

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.digests).toEqual(first.digests);
  });

  /**
   * And never remembered across a change, by any route at all: the key is the
   * file's own state, so a row that does not match the file in front of it is
   * not an answer and is dropped where it is found.
   */
  /**
   * Two people, each with `Docs/notes.txt` of their own.
   *
   * What is remembered is keyed by the file's place on the disk, not by the
   * path somebody typed: the same relative path means two different files the
   * moment there are two volumes, or two personal folders, and a key that
   * could not tell them apart would answer each person the other's digest —
   * a wrong answer given confidently, which is worse than no answer.
   */
  it('are kept apart for two files whose paths differ only in where they are', async () => {
    const { checksums, volume } = await setup();
    const hers = await write(path.join(volume, 'alice', 'Docs', 'notes.txt'), 'hers');
    const his = await write(path.join(volume, 'bob', 'Docs', 'notes.txt'), 'his');

    await checksums.digestsOf({ absolutePath: hers });
    await checksums.digestsOf({ absolutePath: his });

    const remembered = async (absolutePath) =>
      (
        await checksums.remembered({
          absolutePath,
          stats: await fs.stat(absolutePath),
        })
      )?.digests.sha256;

    expect(await remembered(hers)).toBe(digestOf('sha256', 'hers'));
    expect(await remembered(his)).toBe(digestOf('sha256', 'his'));
  });

  it('are taken again once the file has changed', async () => {
    const { checksums, volume } = await setup();
    const file = await write(path.join(volume, 'report.txt'), 'quarterly figures');
    const asked = { absolutePath: file };
    await checksums.digestsOf(asked);

    await rewrite(file, 'quarterly figures, revised');
    const after = await checksums.digestsOf(asked);

    expect(after.fromCache).toBe(false);
    expect(after.digests.sha256).toBe(digestOf('sha256', 'quarterly figures, revised'));
    // And the row that described the old bytes is gone rather than shadowed.
    const stats = await fs.stat(file);
    expect(await checksums.remembered({ absolutePath: file, stats })).not.toBeNull();
  });

  /**
   * The same file, same name, same inode, same length, different bytes: a save
   * in place of exactly the same size, which is what an editor and a shell both
   * do. The time it was last changed is what catches it.
   */
  it('are taken again for a file rewritten in place to the same length', async () => {
    const { checksums, volume } = await setup();
    const file = await write(path.join(volume, 'report.txt'), 'aaaa');
    const asked = { absolutePath: file };
    const before = await checksums.digestsOf(asked);
    const inode = (await fs.stat(file)).ino;

    await rewrite(file, 'bbbb');

    const after = await checksums.digestsOf(asked);
    expect((await fs.stat(file)).ino).toBe(inode);
    expect(after.fromCache).toBe(false);
    expect(after.digests.sha256).toBe(digestOf('sha256', 'bbbb'));
    expect(after.digests.sha256).not.toBe(before.digests.sha256);
  });

  /**
   * A change of the same length and the same moment is the hard case, and the
   * inode is what tells them apart: a file replaced by a copy is a new inode,
   * whatever its dates say.
   */
  it('are taken again for a file replaced by another of the same size', async () => {
    const { checksums, volume } = await setup();
    const file = await write(path.join(volume, 'report.txt'), 'aaaa');
    const asked = { absolutePath: file };
    const before = await checksums.digestsOf(asked);
    const when = (await fs.stat(file)).mtime;

    // Replaced, not written through: a new inode under the same name, with the
    // size and the time put back to what they were.
    const other = await write(path.join(volume, 'other.txt'), 'bbbb');
    await fs.rename(other, file);
    await fs.utimes(file, when, when);

    const after = await checksums.digestsOf(asked);

    expect(after.fromCache).toBe(false);
    expect(after.digests.sha256).not.toBe(before.digests.sha256);
  });

  /**
   * The bytes that were read are not the file any more, which is the one case
   * where an answer must not be remembered: the next reader would be handed
   * digests of something that no longer exists.
   */
  it('remembers nothing when the file changed while it was being read', async () => {
    const { checksums, volume } = await setup();
    const file = await write(path.join(volume, 'big.bin'), 'x'.repeat(8 * 1024 * 1024));

    let touched = false;
    const answer = await checksums.digestsOf({
      absolutePath: file,
      // While the bytes are still being read, so that the file in front of the
      // reader at the end is not the one it started on.
      onProgress: () => {
        if (touched) return;
        touched = true;
        const later = new Date(Date.now() + 5000);
        fsSync.utimesSync(file, later, later);
      },
    });

    expect(touched).toBe(true);
    expect(answer.changedWhileReading).toBe(true);
    expect(answer.digests.sha256).toBe(digestOf('sha256', 'x'.repeat(8 * 1024 * 1024)));
    expect(
      await checksums.remembered({ absolutePath: file, stats: await fs.stat(file) })
    ).toBeNull();
  });

  it('say how far the reading has got', async () => {
    const { checksums, volume } = await setup();
    const file = await write(path.join(volume, 'big.bin'), 'x'.repeat(256 * 1024));
    const seen = [];

    await checksums.digestsOf({
      absolutePath: file,
      onProgress: (read) => seen.push(read),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(256 * 1024);
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
  });

  it('stop when they are asked to', async () => {
    const { checksums, volume } = await setup();
    const file = await write(path.join(volume, 'big.bin'), 'x'.repeat(4 * 1024 * 1024));
    const controller = new AbortController();

    const reading = checksums.digestsOf({
      absolutePath: file,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    await expect(reading).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    // And nothing half-read was remembered.
    const stats = await fs.stat(file);
    expect(await checksums.remembered({ absolutePath: file, stats })).toBeNull();
  });

  it('are forgotten for a path, and for everything under it', async () => {
    const { checksums, volume } = await setup();
    const inside = await write(path.join(volume, 'Docs', 'a.txt'), 'a');
    await checksums.digestsOf({ absolutePath: inside });

    await checksums.forget(path.join(volume, 'Docs'));

    const stats = await fs.stat(inside);
    expect(await checksums.remembered({ absolutePath: inside, stats })).toBeNull();
  });
});
