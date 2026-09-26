import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The two engines that copy a folder.
 *
 * Copying a tree in JavaScript walks it one entry at a time on the only thread
 * the server has; rsync does the same work in one process. Which one runs used
 * to be decided by the platform the process happened to start on, which meant
 * each half was only ever exercised where it was chosen — the native path never
 * on a developer's machine, the JavaScript path never in the container, and
 * neither of them under a test.
 *
 * So the choice is a setting, and these run the same copy through both and
 * require the same tree to come out: the files, the folders, an empty one, and
 * a symbolic link kept as a link rather than followed.
 */

let env;
let transfer;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'transfer-engines-' });
  transfer = load('src/services/fileTransferService');
});

afterEach(async () => {
  delete process.env.FILE_TRANSFER_ENGINE;
  await env.cleanup();
});

/** A tree with the shapes a copy has to carry over. */
const buildTree = async (root) => {
  await fs.mkdir(path.join(root, 'notes', 'deeper'), { recursive: true });
  await fs.mkdir(path.join(root, 'empty'), { recursive: true });
  await fs.writeFile(path.join(root, 'top.txt'), 'top');
  await fs.writeFile(path.join(root, 'notes', 'deeper', 'buried.txt'), 'buried');
  await fs.symlink('top.txt', path.join(root, 'link-to-top'));
};

/** Everything about the copy that has to match: names, kinds, contents, link targets. */
const describeTree = async (root) => {
  const entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  const described = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(entry.parentPath || entry.path, entry.name);
      const relative = path.relative(root, full);
      if (entry.isSymbolicLink()) return `link ${relative} -> ${await fs.readlink(full)}`;
      if (entry.isDirectory()) return `dir  ${relative}`;
      return `file ${relative} = ${await fs.readFile(full, 'utf8')}`;
    })
  );
  return described.sort();
};

const copyWith = async (engine, name) => {
  process.env.FILE_TRANSFER_ENGINE = engine;
  const source = path.join(env.tmpRoot, 'source');
  const destination = path.join(env.tmpRoot, name);
  await transfer.copyEntry(source, destination, true);
  return describeTree(destination);
};

describe('copying a folder', () => {
  it('gives the same tree whichever engine does it', async () => {
    const source = path.join(env.tmpRoot, 'source');
    await buildTree(source);
    const expected = await describeTree(source);

    const byStream = await copyWith('stream', 'by-stream');
    const byNative = await copyWith('native', 'by-native');

    expect(byStream).toEqual(expected);
    expect(byNative).toEqual(expected);
  });

  /**
   * An image without rsync must copy in JavaScript from the start, rather than
   * discovering it is missing halfway through a tree — which is why the
   * question is asked before anything is written.
   */
  it('copies in JavaScript when rsync is not installed', async () => {
    const source = path.join(env.tmpRoot, 'source');
    await buildTree(source);
    const expected = await describeTree(source);

    const emptyPath = path.join(env.tmpRoot, 'no-tools');
    await fs.mkdir(emptyPath, { recursive: true });
    const realPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      expect(await copyWith('native', 'without-rsync')).toEqual(expected);
    } finally {
      process.env.PATH = realPath;
    }
  });

  it('keeps the times, as the JavaScript path does', async () => {
    const source = path.join(env.tmpRoot, 'source');
    await buildTree(source);
    const earlier = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(source, 'top.txt'), earlier, earlier);
    const sourceTime = (await fs.stat(path.join(source, 'top.txt'))).mtimeMs;

    process.env.FILE_TRANSFER_ENGINE = 'native';
    const destination = path.join(env.tmpRoot, 'timed');
    await transfer.copyEntry(source, destination, true);

    const copiedTime = (await fs.stat(path.join(destination, 'top.txt'))).mtimeMs;
    expect(Math.abs(copiedTime - sourceTime)).toBeLessThan(1000);
  });
});
