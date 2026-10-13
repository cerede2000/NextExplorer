import { describe, expect, it } from 'vitest';
import { itemKey, itemRelativePath, pathNameOf, serializeItems } from './items';

/**
 * How an entry is addressed, when that is not what it is called.
 *
 * A name on a disk is bytes. Where they are not valid UTF-8 the server hands
 * over two things: `name`, which is what they read as and holds U+FFFD, and
 * `pathName`, the same name written down so it survives the round trip. A path
 * built out of `name` names nothing — that is the defect — so everything in the
 * client that builds a path or a key asks `pathNameOf` and nothing asks `name`
 * for that purpose.
 *
 * The field is absent for every readable name, so each of these also says what
 * happens then: exactly what happened before, which is the point.
 */

/** As the server sends it: U+FFFE then the bytes in hex. */
const WRITTEN = '￾436f6e7472f46c65';
const READS_AS = 'Contr�le';

const undecodable = (path = 'Maintenance') => ({
  name: READS_AS,
  pathName: WRITTEN,
  path,
  kind: 'txt',
});
const ordinary = (path = 'Maintenance') => ({ name: 'readable.txt', path, kind: 'txt' });

describe('the name an entry is addressed by', () => {
  it('is the written-down one when the server sent one', () => {
    expect(pathNameOf(undecodable())).toBe(WRITTEN);
  });

  it('is simply the name when it did not, which is almost always', () => {
    expect(pathNameOf(ordinary())).toBe('readable.txt');
  });

  it('is nothing for nothing', () => {
    expect(pathNameOf(null)).toBe('');
    expect(pathNameOf({})).toBe('');
  });

  it('ignores a field the server sent empty rather than addressing nothing', () => {
    expect(pathNameOf({ name: 'readable.txt', pathName: '' })).toBe('readable.txt');
  });
});

describe('the path an action is sent for an entry', () => {
  it('is built from the written-down name, not from what it reads as', () => {
    expect(itemRelativePath(undecodable())).toBe(`Maintenance/${WRITTEN}`);
  });

  it('is unchanged for an ordinary name', () => {
    expect(itemRelativePath(ordinary())).toBe('Maintenance/readable.txt');
  });

  it('is what goes in the body of a copy, a move or a delete', () => {
    expect(serializeItems([undecodable(), ordinary()])).toEqual([
      { name: WRITTEN, path: 'Maintenance', kind: 'txt' },
      { name: 'readable.txt', path: 'Maintenance', kind: 'txt' },
    ]);
  });
});

/**
 * Two names that do not decode can read the same: `Contr<f4>le` and
 * `Contr<f5>le` are both `Contr?le` to the eye. Keyed on what they read as,
 * two files share one key — the merge keeps one row for both, and an action on
 * that row reaches whichever of the two it happened to keep.
 */
describe('the key two entries are told apart by', () => {
  const first = { name: READS_AS, pathName: '￾436f6e7472f46c65', path: 'M', kind: 'txt' };
  const second = { name: READS_AS, pathName: '￾436f6e7472f56c65', path: 'M', kind: 'txt' };

  it('is different for two entries that read the same', () => {
    expect(itemKey(first)).not.toBe(itemKey(second));
  });

  it('is the plain one for an ordinary name', () => {
    expect(itemKey(ordinary('Docs'))).toBe('Docs::readable.txt');
  });

  it('is stable for one entry across two listings of it', () => {
    expect(itemKey({ ...first })).toBe(itemKey({ ...first }));
  });
});
