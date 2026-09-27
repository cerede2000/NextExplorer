import path from 'path';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { directories } = require('../../src/config');
const { isThumbnailCachePath } = require('../../src/services/thumbnailService');

describe('Thumbnail Service', () => {
  describe('isThumbnailCachePath', () => {
    it('detects files inside the thumbnail cache directory', () => {
      const thumbnailPath = path.join(
        directories.thumbnails,
        'v2-0123456789abcdef0123456789abcdef01234567.webp'
      );

      expect(isThumbnailCachePath(thumbnailPath)).toBe(true);
    });

    it('detects generated thumbnail artifacts even when the cache is exposed through another path', () => {
      const aliasedPath = path.join(
        directories.volume,
        'cache',
        'thumbnails',
        'v2-0123456789abcdef0123456789abcdef01234567.webp'
      );

      expect(isThumbnailCachePath(aliasedPath)).toBe(true);
    });

    it('detects current v3 generated thumbnail artifacts', () => {
      const thumbnailPath = path.join(
        directories.volume,
        'media',
        'v3-0123456789abcdef0123456789abcdef01234567.webp'
      );

      expect(isThumbnailCachePath(thumbnailPath)).toBe(true);
    });

    it('does not block regular webp files', () => {
      const regularImage = path.join(directories.volume, 'photos', 'cover.webp');

      expect(isThumbnailCachePath(regularImage)).toBe(false);
    });
  });
});
