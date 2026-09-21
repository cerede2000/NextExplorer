import { describe, expect, it } from 'vitest';
import { folderData, mergeListing } from './listing';

/**
 * A fresh listing folded into the one on screen. The rows keep their identity,
 * because a component holding one — a thumbnail being drawn, a row being
 * renamed — must not find it replaced by a copy.
 */

describe('a new listing over the old one', () => {
  it('keeps the same object for an entry that is still there', () => {
    const kept = { name: 'a.txt', path: 'Docs', size: 1 };
    const merged = mergeListing([kept], [{ name: 'a.txt', path: 'Docs', size: 2 }]);
    expect(merged[0]).toBe(kept);
    expect(kept.size).toBe(2);
  });

  it('keeps a thumbnail the server did not send again', () => {
    const kept = { name: 'a.jpg', path: 'Docs', thumbnail: '/t/a.jpg', supportsThumbnail: true };
    mergeListing([kept], [{ name: 'a.jpg', path: 'Docs', supportsThumbnail: true }]);
    expect(kept.thumbnail).toBe('/t/a.jpg');
  });

  // Absent means gone for these: nothing else would ever take them off the row.
  it('drops the editing badge, the version mark and thumbnail support when the server stops sending them', () => {
    const kept = {
      name: 'a.docx',
      path: 'Docs',
      onlyofficeActivity: { active: true },
      versions: { count: 2 },
      supportsThumbnail: true,
    };
    mergeListing([kept], [{ name: 'a.docx', path: 'Docs' }]);
    expect(kept).not.toHaveProperty('onlyofficeActivity');
    expect(kept).not.toHaveProperty('versions');
    expect(kept.supportsThumbnail).toBe(false);
  });

  it('adds what is new and forgets what is gone', () => {
    const merged = mergeListing(
      [{ name: 'gone.txt', path: '' }],
      [{ name: 'new.txt', path: '' }, null, { path: '' }]
    );
    expect(merged.map((entry) => entry.name)).toEqual(['new.txt']);
  });

  it('tells apart two entries of the same name in different folders', () => {
    const inDocs = { name: 'a.txt', path: 'Docs' };
    const merged = mergeListing([inDocs], [{ name: 'a.txt', path: 'Other' }]);
    expect(merged[0]).not.toBe(inDocs);
  });
});

describe('what the folder allows', () => {
  it('reads the access block', () => {
    const data = folderData(
      {
        items: [],
        path: 'Docs',
        access: { canWrite: false, canDelete: false, canSeeVersions: false },
        current: { isDirectory: true },
      },
      'Docs'
    );
    expect(data).toMatchObject({
      path: 'Docs',
      canRead: true,
      canWrite: false,
      canDelete: false,
      canSeeVersions: false,
      isDirectory: true,
      shareInfo: null,
    });
  });

  // An answer without the block allows everything the server did not refuse:
  // hiding actions it would have accepted is the worse mistake.
  it('allows what it is not told to refuse', () => {
    const data = folderData({ items: [] }, 'Docs');
    for (const key of ['canWrite', 'canUpload', 'canDelete', 'canShare', 'canDownload']) {
      expect(data[key]).toBe(true);
    }
    expect(data.path).toBe('Docs');
  });

  it('has nothing to say for the older answer, a bare array', () => {
    expect(folderData([{ name: 'a' }], 'Docs')).toBeNull();
  });
});
