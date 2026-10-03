import { describe, expect, it } from 'vitest';

import { editorRoute } from './editorRoute';

/**
 * Where a file opened in the text editor lives.
 *
 * Written in two places before this and neither knew about a share, so a visitor
 * opening a text file inside one was sent to `/editor/share/<token>/…` — outside
 * the prefix everything else they touch is under, and the one address a rule in
 * front of the application would not have been told about.
 */
describe('the address of a file in the editor', () => {
  it('is under the editor for a file of one’s own', () => {
    expect(editorRoute('Docs/notes.md')).toEqual({ path: '/editor/Docs/notes.md' });
  });

  it('is under the share for a file inside one', () => {
    expect(editorRoute('share/tok1/notes.md')).toEqual({
      path: '/share/tok1/editor/notes.md',
    });
    expect(editorRoute('share/tok1/Deeper/notes.md')).toEqual({
      path: '/share/tok1/editor/Deeper/notes.md',
    });
  });

  it('encodes each segment on its own, so the slashes between them survive', () => {
    expect(editorRoute('Docs/Rapports 2026/été.md')).toEqual({
      path: '/editor/Docs/Rapports%202026/%C3%A9t%C3%A9.md',
    });
    expect(editorRoute('share/to k&1/a b.md')).toEqual({
      path: '/share/to%20k%261/editor/a%20b.md',
    });
  });

  /** A folder merely called `share` is not a share. */
  it('is not fooled by a folder whose name begins with share', () => {
    expect(editorRoute('shared/notes.md')).toEqual({ path: '/editor/shared/notes.md' });
    expect(editorRoute('share')).toEqual({ path: '/editor/share' });
  });
});
