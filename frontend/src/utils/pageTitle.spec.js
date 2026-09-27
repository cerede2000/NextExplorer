import { describe, expect, it } from 'vitest';

import { composeTitle, fileTitleFor, pageTitleFor, TITLE_SEPARATOR } from './pageTitle';

/**
 * The browser tab's title: what the page is, then the instance's name from
 * Settings → Branding (nxzai/NextExplorer discussion #395). Before, the page
 * alone — and "the page" was the last segment of the path whatever the page
 * was, so every settings section, the search and the share lists read
 * "Volumes", untranslated.
 */

const t = (key, values) =>
  values ? `translated:${key}:${JSON.stringify(values)}` : `translated:${key}`;
const known =
  (...keys) =>
  (key) =>
    keys.includes(key);

describe('the title of the tab', () => {
  it('is the page, then the instance’s name, apart by a narrow bar', () => {
    expect(TITLE_SEPARATOR).toBe(' | ');
    expect(composeTitle('Projects', 'Chez Benjy')).toBe('Projects | Chez Benjy');
  });

  it('is the instance’s name alone on a page that is the instance itself', () => {
    expect(composeTitle('', 'Chez Benjy')).toBe('Chez Benjy');
  });

  it('is the page alone while the instance’s name is not known', () => {
    expect(composeTitle('Projects', '')).toBe('Projects');
    expect(composeTitle('Projects', '   ')).toBe('Projects');
  });

  it('is never empty', () => {
    expect(composeTitle('', '')).toBe('Explorer');
    expect(composeTitle(null, undefined)).toBe('Explorer');
  });
});

describe('what a page is called', () => {
  const titleOf = (route, extras) => pageTitleFor(route, t, extras);

  it('is the folder being looked at', () => {
    expect(
      titleOf({
        name: 'FolderView',
        path: '/browse/Projects/Client A',
        params: { path: 'Projects/Client A' },
      })
    ).toBe('Client A');
  });

  it('reads a path given in pieces', () => {
    expect(titleOf({ name: 'FolderView', params: { path: ['Projects', 'Photos'] } })).toBe(
      'Photos'
    );
  });

  it('is the volume list, translated, where there is no folder', () => {
    expect(titleOf({ name: 'HomeView', path: '/browse/', params: {} })).toBe(
      'translated:titles.volumes'
    );
  });

  it('names the trash rather than calling it the volume list', () => {
    expect(titleOf({ name: 'Trash', path: '/trash', params: {} })).toBe('translated:trash.title');
  });

  it('names the section of the settings being looked at', () => {
    const extras = { te: known('settings.categories.accessControl', 'settings.categories.about') };
    expect(titleOf({ path: '/settings/access-control', params: {} }, extras)).toBe(
      'translated:settings.categories.accessControl'
    );
    expect(titleOf({ path: '/settings/about', params: {} }, extras)).toBe(
      'translated:settings.categories.about'
    );
  });

  it('calls a section without a name of its own the settings', () => {
    const extras = { te: known('settings.categories.about') };
    expect(titleOf({ path: '/settings/advanced', params: {} }, extras)).toBe(
      'translated:titles.settings'
    );
    expect(titleOf({ path: '/settings', params: {} }, extras)).toBe('translated:titles.settings');
  });

  it('says what was searched for', () => {
    expect(titleOf({ path: '/search', query: { q: 'facture' }, params: {} })).toBe(
      'translated:search.resultsFor:{"q":"facture"}'
    );
    expect(titleOf({ path: '/search', query: {}, params: {} })).toBe('translated:actions.search');
  });

  it('names the two lists of shares', () => {
    expect(titleOf({ name: 'SharedWithMe', path: '/shares/shared-with-me', params: {} })).toBe(
      'translated:share.sharedWithMe'
    );
    expect(titleOf({ name: 'SharedByMe', path: '/shares/shared-by-me', params: {} })).toBe(
      'translated:share.sharedByMe'
    );
  });

  it('calls the personal folder by the name the sidebar gives it', () => {
    expect(titleOf({ name: 'FolderView', params: { path: 'personal' } })).toBe(
      'translated:drives.myfiles'
    );
    expect(titleOf({ name: 'FolderView', params: { path: 'personal/Photos' } })).toBe('Photos');
  });

  it('calls the top of a share by its name, not by the token in its address', () => {
    const route = { name: 'FolderView', params: { path: 'share/a1b2c3d4e5f6' } };
    expect(titleOf(route, { shareName: 'Dossier client' })).toBe('Dossier client');
    expect(titleOf(route)).toBe('translated:titles.share');
    expect(titleOf({ name: 'FolderView', params: { path: 'share/a1b2c3d4e5f6/Plans' } })).toBe(
      'Plans'
    );
  });
});

describe('what a page showing one file is called', () => {
  it('is the file’s name', () => {
    expect(fileTitleFor('Projects/Client A/devis.md')).toBe('devis.md');
    expect(fileTitleFor('devis.md')).toBe('devis.md');
    expect(fileTitleFor('')).toBe('');
  });
});
