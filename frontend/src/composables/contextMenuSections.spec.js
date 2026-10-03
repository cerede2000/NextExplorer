import { describe, expect, it, vi } from 'vitest';
import { buildMenuSections, quickActionAvailable } from './contextMenuSections';

/**
 * What the right-click menu offers, as a table: a situation in, the entries
 * out. The menu component's spec drives the same rules through a mounted
 * menu; these state them where they are decided, one case each.
 */

const words = { t: (key) => key, modKeyLabel: 'Ctrl+', deleteKeyLabel: 'Del' };

const RUN_NAMES = [
  'getInfo',
  'showVersions',
  'openWithEditor',
  'openWithTerminal',
  'download',
  'downloadAsZip',
  'downloadSeparately',
  'extract',
  'extractHere',
  'compress',
  'share',
  'cut',
  'copy',
  'moveTo',
  'copyTo',
  'pasteIntoDirectory',
  'pasteIntoCurrent',
  'rename',
  'toggleFavorite',
  'delete',
  'newFolder',
  'newFile',
  'openInTab',
  'openInPane',
];
const handlers = () => Object.fromEntries(RUN_NAMES.map((name) => [name, vi.fn()]));

/** Everything allowed, one file selected in an ordinary writable folder. */
const allowed = (overrides = {}) => ({
  kind: 'file',
  hasPrimary: true,
  hasSelection: true,
  isVolumesView: false,
  isShareView: false,
  locationCanShare: true,
  locationCanWrite: true,
  locationCanDelete: true,
  locationCanCreateFolder: true,
  locationCanCreateFile: true,
  canShare: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canRename: true,
  canDelete: true,
  canShowVersions: true,
  canOpenWithTerminal: false,
  isArchiveSelected: false,
  canExtractArchive: false,
  canCompressToZip: true,
  isFavorite: false,
  hasFavoritePath: true,
  isMutatingFavorite: false,
  ...overrides,
});

const menu = (situation, run = handlers()) => buildMenuSections(situation, run, words);
const ids = (situation) =>
  menu(situation)
    .flat()
    .map((entry) => entry.id);
const entry = (situation, id) =>
  menu(situation)
    .flat()
    .find((candidate) => candidate.id === id);

describe('the menu of the folder itself', () => {
  it('offers what the folder allows making, and pasting where something may be made', () => {
    expect(ids(allowed({ kind: 'background' }))).toEqual([
      'get-info',
      'fav-current',
      'new-folder',
      'new-file',
      'paste',
    ]);
  });

  it('offers neither making nor pasting in a folder that allows neither', () => {
    expect(
      ids(
        allowed({
          kind: 'background',
          locationCanCreateFolder: false,
          locationCanCreateFile: false,
        })
      )
    ).toEqual(['get-info', 'fav-current']);
  });
});

describe('what a file offers', () => {
  it('in an ordinary folder, in the order the menu has always had', () => {
    expect(ids(allowed())).toEqual([
      'get-info',
      'versions',
      'open-with-editor',
      'download',
      'compress-zip',
      'share',
      'cut',
      'copy',
      'moveTo',
      'copyTo',
      'rename',
      'delete',
    ]);
  });

  // Left out, not greyed: a read-only folder has no rename, no move, no delete
  // to learn about.
  it('leaves out, on a read-only location, everything that would change it', () => {
    const offered = ids(allowed({ locationCanWrite: false, locationCanDelete: false }));
    for (const id of ['cut', 'moveTo', 'rename', 'delete']) expect(offered).not.toContain(id);
    for (const id of ['copy', 'copyTo', 'download', 'get-info']) expect(offered).toContain(id);
  });

  it('needs both writing and deleting to offer a move', () => {
    const offered = ids(allowed({ locationCanDelete: false }));
    expect(offered).not.toContain('cut');
    expect(offered).not.toContain('moveTo');
    expect(offered).toContain('rename');
  });

  // Greyed, not left out: the location allows it, this selection cannot.
  it('greys out what the selection cannot do where the location allows it', () => {
    expect(entry(allowed({ canRename: false }), 'rename').disabled).toBe(true);
    expect(entry(allowed({ canDelete: false }), 'delete').disabled).toBe(true);
    expect(entry(allowed({ canShare: false }), 'share').disabled).toBe(true);
  });

  it('offers extraction only for an archive', () => {
    expect(ids(allowed())).not.toContain('extract-archive');
    expect(ids(allowed({ isArchiveSelected: true, canExtractArchive: true }))).toEqual(
      expect.arrayContaining(['extract-archive', 'extract-archive-current-folder'])
    );
  });

  it('offers the terminal only for something a shell runs', () => {
    expect(ids(allowed({ canOpenWithTerminal: true }))).toContain('open-with-terminal');
    expect(ids(allowed())).not.toContain('open-with-terminal');
  });

  it('offers no favourite and no paste: those are for folders', () => {
    const offered = ids(allowed());
    expect(offered).not.toContain('fav');
    expect(offered).not.toContain('paste');
  });
});

describe('what a folder offers', () => {
  it('pastes into it and marks it as a favourite, and opens nothing in an editor', () => {
    const offered = ids(allowed({ kind: 'directory', canShowVersions: false }));
    expect(offered).toContain('paste');
    expect(offered).toContain('fav');
    expect(offered).not.toContain('open-with-editor');
  });

  it('says remove rather than add for a folder already a favourite', () => {
    expect(entry(allowed({ kind: 'directory', isFavorite: true }), 'fav').label).toBe(
      'context.removeFromFavorites'
    );
  });

  it('takes no second click on the favourite while the first is going', () => {
    expect(entry(allowed({ kind: 'directory', isMutatingFavorite: true }), 'fav').disabled).toBe(
      true
    );
  });
});

describe('where sharing is not offered at all', () => {
  it('not on the volumes, and nothing is compressed there either', () => {
    const offered = ids(allowed({ isVolumesView: true }));
    expect(offered).not.toContain('share');
    expect(offered).not.toContain('compress-zip');
  });

  it('not inside a share, which is not shared again', () => {
    expect(ids(allowed({ isShareView: true }))).not.toContain('share');
  });

  it('not where the location refuses it', () => {
    expect(ids(allowed({ locationCanShare: false }))).not.toContain('share');
  });
});

describe('every menu, whatever the situation', () => {
  // A wiring mistake — an entry pointed at a handler nobody passed — shows as
  // a click that does nothing. Checked across the corners of the table.
  it('points each entry at something to run, and names each entry once', () => {
    const run = handlers();
    for (const kind of ['background', 'file', 'directory']) {
      for (const truth of [true, false]) {
        const situation = Object.fromEntries(
          Object.keys(allowed()).map((key) => [key, key === 'kind' ? kind : truth])
        );
        const entries = menu(situation, run).flat();
        for (const each of entries) {
          expect([kind, each.id, typeof each.run]).toEqual([kind, each.id, 'function']);
        }
        const names = entries.map((each) => each.id);
        expect(new Set(names).size).toBe(names.length);
      }
    }
  });

  it('runs what the entry names', () => {
    const run = handlers();
    menu(allowed({ kind: 'directory' }), run)
      .flat()
      .find((candidate) => candidate.id === 'paste')
      .run();
    expect(run.pasteIntoDirectory).toHaveBeenCalledTimes(1);
    expect(run.pasteIntoCurrent).not.toHaveBeenCalled();
  });
});

describe('the quick actions on a row', () => {
  const location = { locationCanWrite: true, locationCanDelete: true, canShareHere: true };

  it('offer a volume only what makes sense on a volume', () => {
    const volume = { kind: 'volume', name: 'Media' };
    expect(quickActionAvailable(volume, 'info', location)).toBe(true);
    expect(quickActionAvailable(volume, 'copyName', location)).toBe(true);
    expect(quickActionAvailable(volume, 'delete', location)).toBe(false);
  });

  it('follow the location, as the menu does', () => {
    const file = { kind: 'txt', name: 'a.txt' };
    const readOnly = { locationCanWrite: false, locationCanDelete: false, canShareHere: false };
    for (const id of ['cut', 'rename', 'compress', 'delete', 'share']) {
      expect([id, quickActionAvailable(file, id, readOnly)]).toEqual([id, false]);
    }
    expect(quickActionAvailable(file, 'copy', readOnly)).toBe(true);
  });

  it('favourite only a folder, and offer nothing it does not know', () => {
    expect(quickActionAvailable({ kind: 'directory', name: 'D' }, 'favorite', location)).toBe(true);
    expect(quickActionAvailable({ kind: 'txt', name: 'a' }, 'favorite', location)).toBe(false);
    expect(quickActionAvailable({ kind: 'txt', name: 'a' }, 'launch', location)).toBe(false);
    expect(quickActionAvailable(null, 'info', location)).toBe(false);
  });
});

/**
 * The two ways a selection can leave, offered only where they differ (#487).
 *
 * One file downloads as itself either way and one folder can only be an archive,
 * so in those situations a second entry would do exactly what the first does.
 * The account's own choice is offered first: the habit stays where it was, and
 * the other way is the line below it.
 */
describe('downloading a selection', () => {
  const ids = (situation) =>
    buildMenuSections(situation, handlers(), words)
      .flat()
      .map((entry) => entry.id);

  it('is one entry where there is no choice to make', () => {
    const offered = ids(allowed({ canDownloadSeparately: false }));
    expect(offered).toContain('download');
    expect(offered).not.toContain('download-zip');
    expect(offered).not.toContain('download-separate');
  });

  it('is two entries where the two ways differ', () => {
    const offered = ids(allowed({ canDownloadSeparately: true }));
    expect(offered).not.toContain('download');
    expect(offered).toContain('download-zip');
    expect(offered).toContain('download-separate');
  });

  it.each([
    ['zip', ['download-zip', 'download-separate']],
    ['separate', ['download-separate', 'download-zip']],
  ])('puts the %s choice first for an account that asked for it', (mode, expected) => {
    const offered = ids(allowed({ canDownloadSeparately: true, downloadMode: mode })).filter((id) =>
      id.startsWith('download-')
    );
    expect(offered).toEqual(expected);
  });

  it('runs the one it says it runs', () => {
    const run = handlers();
    const entries = buildMenuSections(allowed({ canDownloadSeparately: true }), run, words)
      .flat()
      .filter((entry) => entry.id.startsWith('download-'));

    entries.find((entry) => entry.id === 'download-separate').run();
    expect(run.downloadSeparately).toHaveBeenCalled();
    expect(run.downloadAsZip).not.toHaveBeenCalled();

    entries.find((entry) => entry.id === 'download-zip').run();
    expect(run.downloadAsZip).toHaveBeenCalled();
  });
});

/**
 * The pane beside this one, offered whether or not tabs are on.
 *
 * A second pane is not a row of tabs: somebody who wants the folder they are copying
 * into beside the one they are copying out of should not have to turn tabs on to get
 * it. And it is about *one* entry, which is what tells it from opening in tabs —
 * four chosen folders are four tabs, and a pane holds one place.
 */
describe('opening something in the pane beside this one', () => {
  it('is offered for one entry that has an address of its own', () => {
    expect(ids(allowed({ canOpenInPane: true }))).toContain('open-in-pane');
  });

  it('is not offered where there is nothing to open there', () => {
    expect(ids(allowed({ canOpenInPane: false }))).not.toContain('open-in-pane');
  });

  it('is offered with tabs off, where opening in a tab is not', () => {
    const situation = allowed({ canOpenInPane: true, canOpenInTab: false });

    expect(ids(situation)).toContain('open-in-pane');
    expect(ids(situation)).not.toContain('open-in-tab');
  });

  it('runs the pane gesture and nothing else', () => {
    const run = handlers();
    const found = menu(allowed({ canOpenInPane: true }), run)
      .flat()
      .find((candidate) => candidate.id === 'open-in-pane');

    found.run();

    expect(run.openInPane).toHaveBeenCalledTimes(1);
    expect(run.openInTab).not.toHaveBeenCalled();
  });

  it('says where it opens, in the catalogue’s own words', () => {
    expect(entry(allowed({ canOpenInPane: true }), 'open-in-pane').label).toBe(
      'tabs.openInRightPane'
    );
  });
});
