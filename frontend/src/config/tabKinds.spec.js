import { describe, expect, it } from 'vitest';
import { TAB_KIND_IDS, TAB_KINDS_BY_ID, tabKindForPath, tabTitle } from './tabKinds';

/**
 * What a tab can hold, recognised from the address.
 *
 * The address is what the application already agrees on, so this is the whole of
 * how a tab knows what it is. Two things are worth holding: that the screens
 * which are *not* places — signing in, a share's password — are recognised as
 * such, because a strip of tabs over them would offer to leave the question
 * unanswered; and that a tab is named after the thing it holds rather than after
 * its address.
 */

const t = (key) => key;

describe('the kind an address belongs to', () => {
  it.each([
    ['/browse/', 'folder'],
    ['/browse/Docs/2026', 'folder'],
    ['/open/Docs/notes.md', 'document'],
    ['/editor/Docs/deploy.sh', 'editor'],
    ['/editor', 'editor'],
    ['/search?q=pangolin', 'search'],
    ['/trash', 'trash'],
    ['/trash/view/12/a.txt', 'trash'],
    ['/versions/view/3/Docs/a.txt', 'versions'],
    ['/shares/shared-with-me', 'shares'],
    ['/settings/about', 'settings'],
  ])('reads %s as %s', (path, kind) => {
    expect(tabKindForPath(path).id).toBe(kind);
  });

  /** A question the application is asking is not a place to keep a tab on. */
  it.each(['/auth/login', '/auth/setup', '/share/abc123', '/', '/browsers', ''])(
    'reads %s as no kind at all',
    (path) => {
      expect(tabKindForPath(path)).toBeNull();
    }
  );

  it('recognises every kind it declares', () => {
    expect(TAB_KIND_IDS.length).toBeGreaterThan(1);
    for (const id of TAB_KIND_IDS) expect(TAB_KINDS_BY_ID[id].icon).toBeTruthy();
  });
});

describe('what a tab is called', () => {
  it('is the folder, for a folder', () => {
    expect(tabTitle({ kind: 'folder', path: '/browse/Docs/2026' }, t)).toBe('2026');
  });

  it('is the volumes, at the top', () => {
    expect(tabTitle({ kind: 'folder', path: '/browse/' }, t)).toBe('breadcrumb.volumes');
    expect(tabTitle({ kind: 'folder', path: '/browse' }, t)).toBe('breadcrumb.volumes');
  });

  it('is the file, for a document and for the editor', () => {
    expect(tabTitle({ kind: 'document', path: '/open/Docs/notes.md' }, t)).toBe('notes.md');
    expect(tabTitle({ kind: 'editor', path: '/editor/Docs/deploy.sh' }, t)).toBe('deploy.sh');
  });

  /** The words the application already uses, rather than a second translation. */
  it('is the name of a named screen', () => {
    expect(tabTitle({ kind: 'trash', path: '/trash' }, t)).toBe('trash.title');
    expect(tabTitle({ kind: 'settings', path: '/settings/about' }, t)).toBe('common.settings');
  });

  it('is decoded, because the address is not', () => {
    expect(tabTitle({ kind: 'folder', path: '/browse/Docs/Mes%20photos' }, t)).toBe('Mes photos');
  });

  /** A percent sign that decodes to nothing is still a name. */
  it('keeps a name that is not valid encoding at all', () => {
    expect(tabTitle({ kind: 'folder', path: '/browse/100%' }, t)).toBe('100%');
  });

  it('says nothing for something that is not a tab', () => {
    expect(tabTitle({ kind: 'telepathy', path: '/wherever' }, t)).toBe('');
    expect(tabTitle(null, t)).toBe('');
  });

  it('drops the query, which is not part of a name', () => {
    expect(tabTitle({ kind: 'search', path: '/search?q=x' }, t)).toBe('actions.search');
  });
});
