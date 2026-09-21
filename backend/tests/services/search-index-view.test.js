import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The way back from a row of the index to the name a reader uses.
 *
 * The queries already stay inside the folder asked about, so from the route
 * none of the refusals below can be reached — which is exactly why they are
 * tested here: they are what stands between a mistake in a query and a file
 * handed to somebody who was never shown the folder it is in.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const load = async () => {
  envContext = await setupTestEnv({ tag: 'search-index-view-' });
  return envContext.requireFresh('src/services/searchIndexView');
};

const neverIgnored = () => false;

describe('the way back from a row', () => {
  it('names a row under the folder in the words of the reader', async () => {
    const { createIndexView } = await load();
    const view = createIndexView({
      base: 'Docs/partage',
      logicalBase: 'share/abc',
      isIgnoredName: neverIgnored,
    });

    expect(view.toLogical('Docs/partage/sous/rapport.txt')).toBe('share/abc/sous/rapport.txt');
    expect(view.toAbsolute('Docs/partage/sous/rapport.txt')).toBe(
      path.join(envContext.volumeDir, 'Docs/partage/sous/rapport.txt')
    );
  });

  it('is the identity for the volume searched under its own name', async () => {
    const { createIndexView } = await load();
    const view = createIndexView({ base: '', logicalBase: '', isIgnoredName: neverIgnored });

    expect(view.toLogical('Docs/rapport.txt')).toBe('Docs/rapport.txt');
  });

  it('refuses whatever is not strictly under the folder', async () => {
    const { createIndexView } = await load();
    const view = createIndexView({
      base: 'Docs/partage',
      logicalBase: 'share/abc',
      isIgnoredName: neverIgnored,
    });

    for (const row of [
      'Docs/partage-bis/rapport.txt', // the same letters, another folder
      'Docs/hors.txt',
      'Docs/partage', // the folder itself, where the reader stands
      'Docs/partage/',
      'Docs/partage//double.txt',
      'Autre/Docs/partage/x.txt',
      '',
      null,
    ]) {
      expect(view.toLogical(row)).toBeNull();
    }
  });

  it('refuses a row inside a folder the search never enters', async () => {
    const { createIndexView } = await load();
    const view = createIndexView({
      base: 'Docs',
      logicalBase: 'Docs',
      isIgnoredName: (name) => name === '_users' || name.startsWith('.'),
    });

    expect(view.toLogical('Docs/_users/x.txt')).toBeNull();
    expect(view.toLogical('Docs/.cache/x.txt')).toBeNull();
    // The entry itself is judged by its name elsewhere, with the reader's
    // setting for hidden files; only the folders on the way are refused here.
    expect(view.toLogical('Docs/.profile')).toBe('Docs/.profile');
  });

  // An assigned volume or its share can hold the personal folders without the
  // reader having any claim on them. The name check above would stop `_users`;
  // this is the check that knows where the personal folders actually are.
  it("refuses somebody's personal folder reached from outside it", async () => {
    const { createIndexView } = await load();
    const view = createIndexView({ base: '', logicalBase: 'Tout', isIgnoredName: neverIgnored });

    expect(view.toLogical('_users/bob/secret.txt')).toBeNull();
    expect(view.toLogical('Public/ouvert.txt')).toBe('Tout/Public/ouvert.txt');
  });

  it('answers inside a personal folder searched from inside it', async () => {
    const { createIndexView } = await load();
    const view = createIndexView({
      base: '_users/bob',
      logicalBase: 'personal',
      isIgnoredName: neverIgnored,
      baseInPersonalRoot: true,
    });

    expect(view.toLogical('_users/bob/notes/a.txt')).toBe('personal/notes/a.txt');
    expect(view.toLogical('_users/bobby/a.txt')).toBeNull();
  });
});

describe('where a folder sits in the volume', () => {
  it('is found through a link, and not outside the volume', async () => {
    const { volumePathOf } = await load();
    const volume = envContext.volumeDir;
    await fs.mkdir(path.join(volume, 'Docs', 'vrai'), { recursive: true });
    await fs.symlink(path.join(volume, 'Docs', 'vrai'), path.join(volume, 'Docs', 'lien'));

    expect(await volumePathOf(volume)).toBe('');
    expect(await volumePathOf(path.join(volume, 'Docs', 'lien'))).toBe('Docs/vrai');
    expect(await volumePathOf(envContext.configDir)).toBeNull();
    expect(await volumePathOf(path.join(volume, 'absent'))).toBeNull();
  });
});
