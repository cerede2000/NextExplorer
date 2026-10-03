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

  /**
   * A share goes to its own prefix.
   *
   * Everything a visitor with no account touches is `/share/<token>/…`, so one rule
   * in front of the application can let a public link through without naming half of
   * it. It used to land in `/browse/share/<token>`, which is where the signed-in
   * application lives.
   */
  it('opens a share under the share prefix, not under the browse one', () => {
    const resolved = router.resolve(folderRoute('share/TOKEN/sub folder'));

    expect(resolved.fullPath).toBe('/share/TOKEN/browse/sub%20folder');
    expect(resolved.name).toBe('ShareBrowse');
    expect(resolved.params.token).toBe('TOKEN');
  });

  it('opens the root of a share with nothing after it', () => {
    expect(folderRoute('share/TOKEN')).toEqual({ path: '/share/TOKEN/browse/' });
    expect(router.resolve(folderRoute('share/TOKEN')).name).toBe('ShareBrowse');
  });

  /**
   * And a link already handed out still reaches it.
   *
   * `router.resolve` matches without following a redirect — a redirect is applied
   * when somebody navigates — so the rule itself is asked, and where it points is
   * resolved the way the router would.
   */
  const followRedirect = (address) => {
    const matched = router.resolve(address);
    const record = matched.matched.find((one) => typeof one.redirect === 'function');
    expect(record, `nothing redirects ${address}`).toBeTruthy();
    return router.resolve(record.redirect(matched));
  };

  it('still reaches a share from the address it used to have', () => {
    const landed = followRedirect('/browse/share/TOKEN/sub%20folder');

    expect(landed.fullPath).toBe('/share/TOKEN/browse/sub%20folder');
    expect(landed.name).toBe('ShareBrowse');
  });

  it('still reaches a shared file in the editor from the address it used to have', () => {
    const landed = followRedirect('/editor/share/TOKEN/notes.md');

    expect(landed.name).toBe('SharedEditor');
    expect(landed.fullPath).toBe('/share/TOKEN/editor/notes.md');
  });

  /**
   * And the rooms of a share are guest routes, never public ones.
   *
   * `public` means the guard answers before it has asked anything, which is right
   * for the door and wrong for what is behind it: that is somebody's files.
   */
  it('guards what is behind the door rather than letting it through', () => {
    const browse = router.resolve(folderRoute('share/TOKEN'));
    const editor = router.resolve({ name: 'SharedEditor', params: { token: 'TOKEN' } });

    for (const resolved of [browse, editor]) {
      const meta = resolved.matched[resolved.matched.length - 1].meta;
      expect(meta.allowGuest).toBe(true);
      expect(meta.public).not.toBe(true);
    }
    expect(router.resolve('/share/TOKEN').matched.at(-1).meta.public).toBe(true);
  });

  it('is still a folder route when a file is named in the query', () => {
    const resolved = router.resolve(folderRoute('Stacks/data', { select: 'a b.txt' }));

    expect(resolved.fullPath).toBe('/browse/Stacks/data?select=a+b.txt');
    expect(resolved.params.path).toBe('Stacks/data');
  });
});
