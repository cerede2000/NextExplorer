import { describe, expect, it } from 'vitest';

import { entryKind, extensionOf } from './readable';

/**
 * What an archive's panel offers to show.
 *
 * The rule has to agree with what a browser can actually draw from raw bytes,
 * because nothing converts anything on the way: a name that offers to open and
 * then shows a broken image is worse than a name that stayed text.
 */

const isEditable = (extension) => ['txt', 'json', 'js', 'log'].includes(extension);

describe('what an entry can be shown as', () => {
  it('reads markdown as markdown', () => {
    expect(entryKind('NOTES.MD', isEditable)).toBe('markdown');
    expect(entryKind('readme.markdown', isEditable)).toBe('markdown');
  });

  it('reads the images a browser decodes on its own', () => {
    for (const name of ['photo.jpg', 'logo.PNG', 'anim.gif', 'shot.webp', 'icon.svg']) {
      expect(entryKind(name, isEditable)).toBe('image');
    }
  });

  it('leaves the images only the server can convert alone', () => {
    // The explorer previews these because it asks the server for a thumbnail.
    // Here the bytes go straight into an <img>, which cannot decode them.
    for (const name of ['scan.tif', 'shot.nef', 'photo.heic', 'raw.cr2', 'shot.dng']) {
      expect(entryKind(name, isEditable)).toBeNull();
    }
  });

  it('reads as text whatever the explorer itself calls text', () => {
    expect(entryKind('notes.txt', isEditable)).toBe('text');
    expect(entryKind('package.json', isEditable)).toBe('text');
    expect(entryKind('server.log', isEditable)).toBe('text');
  });

  it('says no to everything else', () => {
    expect(entryKind('devinv.dll', isEditable)).toBeNull();
    expect(entryKind('setup.exe', isEditable)).toBeNull();
    expect(entryKind('Makefile', isEditable)).toBeNull();
    expect(entryKind('', isEditable)).toBeNull();
    expect(entryKind('.gitignore', isEditable)).toBeNull();
  });

  it('takes the extension after the last dot, in lower case', () => {
    expect(extensionOf('archive.tar.GZ')).toBe('gz');
    expect(extensionOf('no-dot')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
  });
});
