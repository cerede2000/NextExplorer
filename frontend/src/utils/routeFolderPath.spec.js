import { describe, expect, it } from 'vitest';

import { folderPathOfRoute } from './routeFolderPath';

/**
 * Where a listing is, said once.
 *
 * Four places were working this out and a share says it in a shape only some of
 * them knew: `/browse/<path>` keeps the whole folder in one parameter, and a
 * share's own address keeps the token apart from what follows it, because the
 * token decides who may see any of it. Read as one parameter, a share's listing
 * had no folder at all — opening a subfolder inside it navigated out of the share
 * and the visitor was sent to a sign-in screen.
 */
describe('the folder a route is on', () => {
  it('is the whole parameter for an ordinary listing', () => {
    expect(folderPathOfRoute({ params: { path: 'Docs/Reports' } })).toBe('Docs/Reports');
    expect(folderPathOfRoute({ params: { path: ['Docs', 'Reports'] } })).toBe('Docs/Reports');
    expect(folderPathOfRoute({ params: {} })).toBe('');
    expect(folderPathOfRoute(null)).toBe('');
  });

  it('puts the share back in front of what follows it', () => {
    expect(folderPathOfRoute({ params: { token: 'tok1', path: ['Plans'] } })).toBe(
      'share/tok1/Plans'
    );
    expect(folderPathOfRoute({ params: { token: 'tok1', path: ['Plans', '2026'] } })).toBe(
      'share/tok1/Plans/2026'
    );
  });

  /** The root of a share is the share itself, which is a folder like any other. */
  it('names the share itself at the top of one', () => {
    expect(folderPathOfRoute({ params: { token: 'tok1', path: [] } })).toBe('share/tok1');
    expect(folderPathOfRoute({ params: { token: 'tok1' } })).toBe('share/tok1');
  });

  it('refuses a token that is not a string', () => {
    expect(folderPathOfRoute({ params: { token: ['a'], path: ['Plans'] } })).toBe('Plans');
  });

  it('leaves no slash at either end', () => {
    expect(folderPathOfRoute({ params: { path: '/Docs/' } })).toBe('Docs');
    expect(folderPathOfRoute({ params: { token: 'tok1', path: ['', 'Plans', ''] } })).toBe(
      'share/tok1/Plans'
    );
  });
});
