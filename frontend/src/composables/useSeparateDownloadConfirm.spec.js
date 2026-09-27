import { describe, expect, it } from 'vitest';
import {
  SEPARATE_DOWNLOAD_THRESHOLD,
  useSeparateDownloadConfirm,
} from './useSeparateDownloadConfirm';

/**
 * The question asked before a selection becomes a great many downloads (#487).
 *
 * A handful is not worth a dialog, and a hundred is: the threshold is the whole
 * behaviour, so it is asserted at its edge rather than somewhere safely past it.
 */

const confirm = useSeparateDownloadConfirm();

describe('the question about a large selection', () => {
  it('is the same object wherever it is asked for', () => {
    expect(useSeparateDownloadConfirm()).toBe(confirm);
  });

  it('answers itself at the threshold, and asks one past it', async () => {
    await expect(confirm.requestConfirmation({ files: SEPARATE_DOWNLOAD_THRESHOLD })).resolves.toBe(
      'separate'
    );
    expect(confirm.isOpen.value).toBe(false);

    const pending = confirm.requestConfirmation({ files: SEPARATE_DOWNLOAD_THRESHOLD + 1 });
    expect(confirm.isOpen.value).toBe(true);
    expect(confirm.fileCount.value).toBe(SEPARATE_DOWNLOAD_THRESHOLD + 1);

    confirm.chooseSeparate();
    await expect(pending).resolves.toBe('separate');
    expect(confirm.isOpen.value).toBe(false);
  });

  it('carries how many folders are coming, for the sentence that says so', async () => {
    const pending = confirm.requestConfirmation({ files: 40, folders: 3 });
    expect(confirm.folderCount.value).toBe(3);
    confirm.cancel();
    await pending;
  });

  it.each([
    ['chooseZip', 'zip'],
    ['cancel', null],
  ])('resolves with what %s means', async (action, expected) => {
    const pending = confirm.requestConfirmation({ files: 40 });
    confirm[action]();
    await expect(pending).resolves.toBe(expected);
  });

  /**
   * Whoever is waiting on the first question is holding a download that will
   * never start. A second question answers it rather than leaving it open.
   */
  it('answers the question it replaces', async () => {
    const first = confirm.requestConfirmation({ files: 40 });
    const second = confirm.requestConfirmation({ files: 80 });

    await expect(first).resolves.toBe(null);
    expect(confirm.fileCount.value).toBe(80);

    confirm.chooseSeparate();
    await expect(second).resolves.toBe('separate');
  });

  it('does nothing when nobody is waiting', () => {
    expect(() => confirm.cancel()).not.toThrow();
    expect(confirm.isOpen.value).toBe(false);
  });
});
