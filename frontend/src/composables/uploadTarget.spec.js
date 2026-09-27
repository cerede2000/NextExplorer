import { describe, expect, it } from 'vitest';

import {
  directUploadEndpoint,
  folderUploadParts,
  uploadPermission,
  uploadBlockedMessage,
  UPLOAD_BLOCKED,
} from './uploadTarget';

/**
 * Where a file goes, and whether it may go there.
 *
 * Lifted out of an 820-line composable holding seven stores, which CI measured
 * at two per cent covered — the least tested file in the application, and the
 * one every byte enters through. These three decisions are the ones whose
 * failure is visible from outside: a file in the wrong folder, a dropped folder
 * that loses its shape, or somebody refused an upload they were entitled to.
 */

const fileWith = (meta) => ({ meta });

describe('the endpoint a direct upload posts to', () => {
  it('carries the destination', () => {
    const endpoint = directUploadEndpoint(fileWith({ uploadTo: 'Documents' }));

    expect(endpoint).toContain('uploadTo=Documents');
  });

  it('carries every key the server reads', () => {
    const endpoint = directUploadEndpoint(
      fileWith({
        uploadTo: 'Documents',
        relativePath: 'photos/summer.jpg',
        resolvedRelativePath: 'photos (1)/summer.jpg',
        uploadBatchId: 'batch-7',
      })
    );

    expect(endpoint).toContain('uploadTo=Documents');
    expect(endpoint).toContain('relativePath=photos%2Fsummer.jpg');
    expect(endpoint).toContain('resolvedRelativePath=photos+%281%29%2Fsummer.jpg');
    expect(endpoint).toContain('uploadBatchId=batch-7');
  });

  /** Anything else in the meta is the uploader's business, not the server's. */
  it('sends nothing the server does not read', () => {
    const endpoint = directUploadEndpoint(fileWith({ uploadTo: 'Docs', secret: 'do-not-send' }));

    expect(endpoint).not.toContain('secret');
  });

  /**
   * An empty value in the query is not the same as its absence: the server
   * would read it as a destination of "", which is the volume root.
   */
  it('leaves out a key whose value is empty', () => {
    const endpoint = directUploadEndpoint(fileWith({ uploadTo: 'Docs', relativePath: '' }));

    expect(endpoint).not.toContain('relativePath');
  });

  it('leaves out a key that is not a string', () => {
    const endpoint = directUploadEndpoint(fileWith({ uploadTo: 'Docs', uploadBatchId: 7 }));

    expect(endpoint).not.toContain('uploadBatchId');
  });

  it('has no query at all when there is nothing to say', () => {
    expect(directUploadEndpoint(fileWith({}))).not.toContain('?');
    expect(directUploadEndpoint(undefined)).not.toContain('?');
  });

  it('escapes a destination that would otherwise break the query', () => {
    const endpoint = directUploadEndpoint(fileWith({ uploadTo: 'Rock & Roll/Live?' }));

    expect(endpoint).toContain('uploadTo=Rock+%26+Roll%2FLive%3F');
  });
});

describe('the folder a file arrived inside', () => {
  it('is read from the meta the uploader set', () => {
    expect(folderUploadParts({ meta: { relativePath: 'trip/day1/photo.jpg' } })).toEqual([
      'trip',
      'day1',
      'photo.jpg',
    ]);
  });

  /** What a folder input gives, when nothing set the meta. */
  it('falls back to what the browser reported', () => {
    expect(folderUploadParts({ data: { webkitRelativePath: 'trip/photo.jpg' } })).toEqual([
      'trip',
      'photo.jpg',
    ]);
  });

  /** A single segment is a file on its own, whichever source it came from. */
  it('is nothing for a file dropped by itself', () => {
    expect(folderUploadParts({ name: 'photo.jpg' })).toBeNull();
    expect(folderUploadParts({ meta: { relativePath: 'photo.jpg' } })).toBeNull();
  });

  it('is nothing when there is nothing to go on', () => {
    expect(folderUploadParts({})).toBeNull();
    expect(folderUploadParts(undefined)).toBeNull();
  });

  it('ignores the empty segments a stray slash leaves behind', () => {
    expect(folderUploadParts({ meta: { relativePath: '/trip//photo.jpg' } })).toEqual([
      'trip',
      'photo.jpg',
    ]);
  });
});

describe('whether this location accepts an upload', () => {
  it('accepts one where the listing says it may', () => {
    expect(uploadPermission({ canUpload: true }, 'Documents').allowed).toBe(true);
  });

  it('refuses one where the listing says it may not', () => {
    expect(uploadPermission({ canUpload: false }, 'Documents').allowed).toBe(false);
  });

  /**
   * A share whose metadata has not arrived fails closed. The alternative is
   * uploading into somebody else's read-only share because the answer had not
   * come back yet.
   */
  it('refuses a share whose permissions have not arrived', () => {
    expect(uploadPermission(null, 'share/aBc123/photos').allowed).toBe(false);
  });

  /**
   * And nowhere else, because not knowing yet is the ordinary state before a
   * listing loads — refusing there would stop somebody uploading into their own
   * folder for no reason.
   */
  it('allows an ordinary folder whose listing has not arrived', () => {
    expect(uploadPermission(null, 'Documents').allowed).toBe(true);
    expect(uploadPermission(null, '').allowed).toBe(true);
  });

  it('does not mistake a folder named like a share for one', () => {
    expect(uploadPermission(null, 'shared-with-me/photos').allowed).toBe(true);
  });
});

describe('why an upload was refused', () => {
  it('says a read-only share is read-only', () => {
    const { reason } = uploadPermission(
      { canUpload: false, shareInfo: { accessMode: 'readonly' } },
      'share/aBc123'
    );

    expect(reason).toBe(UPLOAD_BLOCKED.shareReadOnly);
    expect(uploadBlockedMessage(reason)).toMatch(/read-only/i);
  });

  it('says a share that has not loaded has not loaded', () => {
    const { reason } = uploadPermission(null, 'share/aBc123');

    expect(reason).toBe(UPLOAD_BLOCKED.shareLoading);
    expect(uploadBlockedMessage(reason)).toMatch(/still loading/i);
  });

  it('otherwise says it is a matter of permission', () => {
    const { reason } = uploadPermission({ canUpload: false }, 'Documents');

    expect(reason).toBe(UPLOAD_BLOCKED.notPermitted);
    expect(uploadBlockedMessage(reason)).toMatch(/permission/i);
  });

  /** Nothing to explain when nothing was refused. */
  it('has no reason when the upload is allowed', () => {
    expect(uploadPermission({ canUpload: true }, 'Documents').reason).toBeNull();
  });

  it('still says something for a reason it does not know', () => {
    expect(uploadBlockedMessage('something-else')).toBeTruthy();
    expect(uploadBlockedMessage(undefined)).toBeTruthy();
  });
});
