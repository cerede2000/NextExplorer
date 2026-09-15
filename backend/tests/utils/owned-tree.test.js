import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath } from '../helpers/env-test-utils.js';

/**
 * Undoing what an operation wrote without touching what someone else put there.
 *
 * The inventory is taken before the entry is moved into place; the undo runs
 * where the entry landed, after someone may have added to it.
 */

let root;
let owned;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextexplorer-owned-'));
  owned = require(modulePath('src/utils/ownedTree'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (relative, content) => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

const tree = (directory) => {
  const out = [];
  const walk = (current, prefix) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      out.push(relative);
      if (fs.lstatSync(full).isDirectory()) walk(full, relative);
    }
  };
  walk(directory, '');
  return out;
};

describe('removing what an operation wrote', () => {
  it('removes a whole tree it wrote, once moved into place', async () => {
    write('staging/photos/a.jpg', 'a');
    write('staging/photos/nested/b.jpg', 'b');
    const inventory = await owned.takeInventory(path.join(root, 'staging/photos'));
    fs.renameSync(path.join(root, 'staging/photos'), path.join(root, 'photos'));

    const kept = await owned.removeInventoried(path.join(root, 'photos'), inventory);

    expect(kept).toEqual([]);
    expect(fs.existsSync(path.join(root, 'photos'))).toBe(false);
  });

  it('keeps a file someone saved into the placed folder, and the folders holding it', async () => {
    write('staging/photos/a.jpg', 'a');
    write('staging/photos/nested/b.jpg', 'b');
    const inventory = await owned.takeInventory(path.join(root, 'staging/photos'));
    fs.renameSync(path.join(root, 'staging/photos'), path.join(root, 'photos'));
    write('photos/nested/theirs.jpg', 'theirs');

    const kept = await owned.removeInventoried(path.join(root, 'photos'), inventory);

    expect(tree(path.join(root, 'photos'))).toEqual(['nested', 'nested/theirs.jpg']);
    expect(fs.readFileSync(path.join(root, 'photos/nested/theirs.jpg'), 'utf8')).toBe('theirs');
    expect(kept).toEqual([path.join(root, 'photos/nested/theirs.jpg')]);
  });

  it('keeps a file that replaced one of its own under the same name', async () => {
    write('staging/report.txt', 'mine');
    const inventory = await owned.takeInventory(path.join(root, 'staging/report.txt'));
    fs.renameSync(path.join(root, 'staging/report.txt'), path.join(root, 'report.txt'));
    fs.rmSync(path.join(root, 'report.txt'));
    write('report.txt', 'theirs');

    await owned.removeInventoried(path.join(root, 'report.txt'), inventory);

    expect(fs.readFileSync(path.join(root, 'report.txt'), 'utf8')).toBe('theirs');
  });

  it('keeps a folder someone created inside, even an empty one', async () => {
    write('staging/photos/a.jpg', 'a');
    const inventory = await owned.takeInventory(path.join(root, 'staging/photos'));
    fs.renameSync(path.join(root, 'staging/photos'), path.join(root, 'photos'));
    fs.mkdirSync(path.join(root, 'photos/theirs'));

    await owned.removeInventoried(path.join(root, 'photos'), inventory);

    expect(tree(path.join(root, 'photos'))).toEqual(['theirs']);
  });

  it('removes a link it wrote without following it', async () => {
    write('outside.txt', 'not the operation’s');
    fs.mkdirSync(path.join(root, 'staging'));
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(root, 'staging/link'));
    const inventory = await owned.takeInventory(path.join(root, 'staging/link'));
    fs.renameSync(path.join(root, 'staging/link'), path.join(root, 'link'));

    await owned.removeInventoried(path.join(root, 'link'), inventory);

    expect(fs.lstatSync(path.join(root, 'link'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('not the operation’s');
  });

  it('has nothing to do for an entry already gone', async () => {
    write('staging/a.txt', 'a');
    const inventory = await owned.takeInventory(path.join(root, 'staging/a.txt'));

    await expect(owned.removeInventoried(path.join(root, 'gone.txt'), inventory)).resolves.toEqual(
      []
    );
  });
});
