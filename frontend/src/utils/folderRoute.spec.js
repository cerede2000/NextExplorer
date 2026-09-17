import { describe, it, expect } from 'vitest';
import { encodeFolderPath, folderRoute } from './folderRoute.js';
// The application's own router, so what is tested is the route people reach.
import router from '@/router/index.js';

describe('the address of a folder', () => {
  it('keeps the slashes between folders and encodes what is inside a name', () => {
    expect(encodeFolderPath('Stacks/data')).toBe('Stacks/data');
    expect(encodeFolderPath('Docs/Rapports 2026/été.txt')).toBe(
      'Docs/Rapports%202026/%C3%A9t%C3%A9.txt'
    );
    // A name may contain the characters that mean something in an address.
    expect(encodeFolderPath('Comptes/50%/a?b#c')).toBe('Comptes/50%25/a%3Fb%23c');
  });

  it('drops the empty pieces a stray slash leaves behind', () => {
    expect(encodeFolderPath('/Stacks//data/')).toBe('Stacks/data');
    expect(encodeFolderPath('')).toBe('');
    expect(encodeFolderPath(null)).toBe('');
  });

  it('is a path, which is what keeps the slashes out of the encoder', () => {
    expect(folderRoute('Stacks/data')).toEqual({ path: '/browse/Stacks/data' });
    expect(folderRoute('')).toEqual({ path: '/browse/' });
  });

  it('carries a query only when there is one', () => {
    expect(folderRoute('Stacks', { select: 'notes.txt' })).toEqual({
      path: '/browse/Stacks',
      query: { select: 'notes.txt' },
    });
    expect(folderRoute('Stacks', {})).toEqual({ path: '/browse/Stacks' });
    expect(folderRoute('Stacks', undefined)).toEqual({ path: '/browse/Stacks' });
  });
});

describe('through the application router', () => {
  it('reaches the same folder as the address it replaces', () => {
    const plain = router.resolve(folderRoute('Stacks/data'));
    const legacy = router.resolve('/browse/Stacks%2Fdata');

    expect(plain.fullPath).toBe('/browse/Stacks/data');
    expect(plain.name).toBe('FolderView');
    expect(plain.params.path).toBe('Stacks/data');
    // The shape saved in somebody's bookmarks still lands in the same place.
    expect(legacy.name).toBe('FolderView');
    expect(legacy.params.path).toBe('Stacks/data');
  });

  it('gives back a name with a space or an accent in it', () => {
    const resolved = router.resolve(folderRoute('Docs/Rapports 2026/été'));

    expect(resolved.params.path).toBe('Docs/Rapports 2026/été');
  });

  it('opens a share the same way', () => {
    const resolved = router.resolve(folderRoute('share/TOKEN/sub folder'));

    expect(resolved.name).toBe('FolderView');
    expect(resolved.params.path).toBe('share/TOKEN/sub folder');
  });

  it('is still a folder route when a file is named in the query', () => {
    const resolved = router.resolve(folderRoute('Stacks/data', { select: 'a b.txt' }));

    expect(resolved.fullPath).toBe('/browse/Stacks/data?select=a+b.txt');
    expect(resolved.params.path).toBe('Stacks/data');
  });
});
