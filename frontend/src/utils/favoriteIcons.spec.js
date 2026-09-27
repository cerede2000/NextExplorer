import { describe, it, expect } from 'vitest';
import * as OutlineIcons from '@heroicons/vue/24/outline';
import * as SolidIcons from '@heroicons/vue/24/solid';
import { resolveFavoriteIcon, normalizeIconVariant } from './favoriteIcons';

describe('favorite icon resolution', () => {
  it('resolves each variant to its own icon set', () => {
    expect(resolveFavoriteIcon('outline:FolderIcon')).toBe(OutlineIcons.FolderIcon);
    expect(resolveFavoriteIcon('solid:FolderIcon')).toBe(SolidIcons.FolderIcon);
  });

  it('keeps every icon distinct in outline, not just the star', () => {
    // The edit dialog used to store an unknown variant, which sent every
    // outline icon through the default and turned the whole grid into stars.
    const icons = ['FolderIcon', 'HomeIcon', 'HeartIcon', 'CloudIcon'].map((name) =>
      resolveFavoriteIcon(`outline:${name}`)
    );
    expect(new Set(icons).size).toBe(icons.length);
    expect(icons).not.toContain(OutlineIcons.StarIcon);
  });

  it('recovers favorites saved with the legacy outline-solid variant', () => {
    expect(normalizeIconVariant('outline-solid')).toBe('outline');
    expect(resolveFavoriteIcon('outline-solid:HomeIcon')).toBe(OutlineIcons.HomeIcon);
  });

  it('falls back to the outline star for anything unusable', () => {
    expect(resolveFavoriteIcon('')).toBe(OutlineIcons.StarIcon);
    expect(resolveFavoriteIcon(null)).toBe(OutlineIcons.StarIcon);
    expect(resolveFavoriteIcon('outline:NotAnIcon')).toBe(OutlineIcons.StarIcon);
  });

  it('still accepts a bare icon name', () => {
    expect(resolveFavoriteIcon('HomeIcon')).toBe(OutlineIcons.HomeIcon);
  });
});
