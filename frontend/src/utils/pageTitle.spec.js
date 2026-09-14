import { describe, expect, it } from 'vitest';

import { pageTitleFor } from './pageTitle';

const t = (key) => `translated:${key}`;

describe('the title of a page', () => {
  it('is the folder being looked at', () => {
    expect(pageTitleFor({ name: 'FolderView', params: { path: 'Projects/Client A' } }, t)).toBe(
      'Client A'
    );
  });

  it('reads a path given in pieces', () => {
    expect(pageTitleFor({ name: 'FolderView', params: { path: ['Projects', 'Photos'] } }, t)).toBe(
      'Photos'
    );
  });

  it('is the volume list where there is no folder', () => {
    expect(pageTitleFor({ name: 'HomeView', params: {} }, t)).toBe('Volumes');
  });

  it('names the trash rather than calling it the volume list', () => {
    expect(pageTitleFor({ name: 'Trash', params: {} }, t)).toBe('translated:trash.title');
  });
});
