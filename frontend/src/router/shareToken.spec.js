import { describe, expect, it } from 'vitest';

import { shareTokenOf } from './shareToken';

/**
 * Which share an address is about — the one question that has to be right before
 * anything else is asked.
 *
 * It decides which share `resolveShareAccess` checks. Reading the wrong token out
 * of an address checks the wrong share, and a visitor carrying a valid session for
 * one would be let into another; reading none where there is one sends somebody
 * with a perfectly good link to a sign-in screen.
 */
describe('which share an address is about', () => {
  it('reads it from a share’s own addresses', () => {
    expect(shareTokenOf({ name: 'ShareBrowse', params: { token: 'tok1', path: ['Docs'] } })).toBe(
      'tok1'
    );
    expect(
      shareTokenOf({ name: 'ShareDocument', params: { token: 'tok2', path: ['a.pdf'] } })
    ).toBe('tok2');
    expect(shareTokenOf({ name: 'SharedEditor', params: { token: 'tok3' } })).toBe('tok3');
  });

  /** Links already handed out still arrive in the shape the share used to have. */
  it('reads it out of the folder path of the address a share used to have', () => {
    expect(shareTokenOf({ name: 'FolderView', params: { path: 'share/tok4/Docs' } })).toBe('tok4');
    expect(shareTokenOf({ name: 'FolderView', params: { path: ['share', 'tok5', 'Docs'] } })).toBe(
      'tok5'
    );
  });

  it('says nothing about an address that is not a share', () => {
    expect(shareTokenOf({ name: 'FolderView', params: { path: 'Docs/Reports' } })).toBe('');
    expect(shareTokenOf({ name: 'HomeView', params: {} })).toBe('');
    expect(shareTokenOf(null)).toBe('');
    expect(shareTokenOf({})).toBe('');
  });

  /**
   * And a folder of somebody's own called `share` is not a share.
   *
   * The old shape reads the share out of the path, so a real folder named `share`
   * at the root of a volume is the one thing that looks like one. It names no
   * token — there is nothing after it — and an empty answer is what sends the
   * address through the ordinary rules instead of the share ones.
   */
  it('names no share for a folder that is merely called share', () => {
    expect(shareTokenOf({ name: 'FolderView', params: { path: 'share' } })).toBe('');
  });

  /**
   * Nor for one whose name merely begins with it.
   *
   * `shared/docs` is a folder called `shared`. Matched on the word alone rather
   * than on the segment, its second segment would be read as a token — and a
   * visitor's own folder would be checked against a share that does not exist, or
   * worse, against one that does.
   */
  it('names no share for a folder whose name only begins with it', () => {
    expect(shareTokenOf({ name: 'FolderView', params: { path: 'shared/docs' } })).toBe('');
    expect(shareTokenOf({ name: 'FolderView', params: { path: 'shareholders/2026' } })).toBe('');
  });

  /**
   * A token is read from the parameter the route carries, never from the rest of
   * the address: on a share's own routes the path after the token is somebody's
   * file names, and a file called `share` inside one must not be mistaken for a
   * share of its own.
   */
  it('is not confused by what a share holds', () => {
    expect(
      shareTokenOf({ name: 'ShareBrowse', params: { token: 'tok6', path: ['share', 'tok7'] } })
    ).toBe('tok6');
  });

  it('refuses a token that is not a string', () => {
    expect(shareTokenOf({ name: 'ShareBrowse', params: { token: ['a', 'b'] } })).toBe('');
    expect(shareTokenOf({ name: 'ShareBrowse', params: {} })).toBe('');
  });
});
