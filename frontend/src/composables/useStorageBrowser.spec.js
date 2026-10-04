import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Walking folders inside a dialog, from a page that is a share.
 *
 * A visitor holding a share link has no storage above the share: `/api/browse`
 * is not their address, and the dialogs that walk folders — "Copy to", "Extract
 * to", the picker the editor opens, the versions panel's "Copy version to" —
 * asked there and told them the folder could not be listed. Two things make that
 * work: the listing comes through the share's own door, and the walk cannot be
 * sent above the share, whose token is not a folder anybody chose.
 */

const browse = vi.fn();
vi.mock('@/api', () => ({
  browse: (...args) => browse(...args),
  normalizePath: (value = '') => String(value).replace(/^\/+|\/+$/g, ''),
}));

const auth = vi.hoisted(() => ({ isGuest: false }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));

import { confinedRoot, useStorageBrowser } from './useStorageBrowser';

const SHARE = 'share/TOKEN';

const listing = (path, items = []) => ({ path, items });

const onPage = (pathname) => window.history.replaceState({}, '', pathname);

beforeEach(() => {
  browse.mockReset();
  browse.mockImplementation(async (path) => listing(path));
  auth.isGuest = false;
  onPage('/browse/Projects');
});

afterEach(() => {
  onPage('/browse/Projects');
});

describe('the top of the walk', () => {
  it('is the share for a visitor reading one', () => {
    auth.isGuest = true;
    onPage('/share/TOKEN/browse/Papers');

    expect(confinedRoot()).toBe(SHARE);
  });

  /** An account has its own storage above the share, and copies things out of it. */
  it('is the storage itself for an account, share or not', () => {
    onPage('/share/TOKEN/browse/Papers');

    expect(confinedRoot()).toBe('');
  });

  it('is the storage itself anywhere else', () => {
    auth.isGuest = true;
    onPage('/browse/Projects');

    expect(confinedRoot()).toBe('');
  });
});

describe('a walk confined to a share', () => {
  const walk = () => {
    const browser = useStorageBrowser();
    browser.root.value = SHARE;
    return browser;
  };

  it('lists the share when asked for the top of the storage', async () => {
    const browser = walk();

    await browser.navigate('');

    expect(browse).toHaveBeenCalledWith(SHARE);
    expect(browser.currentPath.value).toBe(SHARE);
  });

  it('stays inside it when sent above it', async () => {
    const browser = walk();

    await browser.navigate('Projects');

    expect(browse).toHaveBeenCalledWith(SHARE);
  });

  it('walks in as usual', async () => {
    const browser = walk();

    await browser.navigate(`${SHARE}/Papers/Drafts`);

    expect(browse).toHaveBeenCalledWith(`${SHARE}/Papers/Drafts`);
  });

  /**
   * The crumbs name folders. `share` and the token are not folders anybody
   * chose, and the first of them is a step this visitor cannot take.
   */
  it('names only the folders below the share', async () => {
    const browser = walk();

    await browser.navigate(`${SHARE}/Papers/Drafts`);

    expect(browser.crumbs.value).toEqual([
      { name: 'Papers', path: `${SHARE}/Papers` },
      { name: 'Drafts', path: `${SHARE}/Papers/Drafts` },
    ]);
  });
});

describe('a walk that is not confined', () => {
  it('goes to the top of the storage and names every folder', async () => {
    const browser = useStorageBrowser();

    await browser.navigate('Projects/Papers');

    expect(browse).toHaveBeenCalledWith('Projects/Papers');
    expect(browser.crumbs.value).toEqual([
      { name: 'Projects', path: 'Projects' },
      { name: 'Papers', path: 'Projects/Papers' },
    ]);

    await browser.navigate('');
    expect(browse).toHaveBeenLastCalledWith('');
  });
});
