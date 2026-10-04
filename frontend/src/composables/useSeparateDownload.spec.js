import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The order the steps are in, which is the whole point of this file (#487).
 *
 * Asking the server for a plan is what counts the download — once for the
 * selection, as an archive would be. So everything that can still end in
 * nothing has to happen before it: the question about a large selection, and
 * the folder picker. A plan made and then abandoned is a download the share's
 * owner sees in their counter and nobody ever received.
 */

const m = vi.hoisted(() => ({
  createDownloadPlan: vi.fn(),
  requestConfirmation: vi.fn(),
  canWriteToChosenFolder: vi.fn(),
  chooseDownloadFolder: vi.fn(),
  writePartsToFolder: vi.fn(),
  clickPartsThrough: vi.fn(),
  addNotification: vi.fn(),
  startOperation: vi.fn(),
  updateOperation: vi.fn(),
  finishOperation: vi.fn(),
}));

vi.mock('@/api', () => ({ createDownloadPlan: (...a) => m.createDownloadPlan(...a) }));
vi.mock('@/i18n', () => ({ default: { global: { t: (key) => key } } }));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification: m.addNotification }),
}));
vi.mock('@/stores/operationTasks', () => ({
  useOperationTasksStore: () => ({
    startOperation: m.startOperation,
    updateOperation: m.updateOperation,
    finishOperation: m.finishOperation,
  }),
}));
vi.mock('@/composables/useSeparateDownloadConfirm', () => ({
  useSeparateDownloadConfirm: () => ({ requestConfirmation: m.requestConfirmation }),
}));
vi.mock('@/composables/separateDownloads', () => ({
  canWriteToChosenFolder: (...a) => m.canWriteToChosenFolder(...a),
  chooseDownloadFolder: (...a) => m.chooseDownloadFolder(...a),
  writePartsToFolder: (...a) => m.writePartsToFolder(...a),
  clickPartsThrough: (...a) => m.clickPartsThrough(...a),
  knownTotalBytes: () => 10,
  partsOf: () => [{ part: 0 }, { part: 1 }],
}));

import { useSeparateDownload } from './useSeparateDownload';

const PLAN = { token: 'tok', files: [{ index: 0, name: 'a.txt', size: 4 }], archive: null };
const ask = { paths: ['Docs/a.txt', 'Docs/b.txt'], basePath: 'Docs', fileCount: 2 };
/**
 * Where the selection came from travels with the plan.
 *
 * The parts are fetched later, from somewhere that no longer knows, and a plan
 * made inside a share has to be fetched under that share's prefix like
 * everything else a visitor asks for.
 */
const CARRIED = { ...PLAN, basePath: ask.basePath };

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.requestConfirmation.mockResolvedValue('separate');
  m.createDownloadPlan.mockResolvedValue(PLAN);
  m.canWriteToChosenFolder.mockReturnValue(false);
  m.clickPartsThrough.mockResolvedValue({ parts: 2 });
  m.writePartsToFolder.mockResolvedValue({ renamed: [] });
  m.startOperation.mockReturnValue('op-1');
});

describe('nothing is counted for a download that does not happen', () => {
  it('asks for no plan when the question was declined', async () => {
    m.requestConfirmation.mockResolvedValue(null);

    await expect(useSeparateDownload().run(ask)).resolves.toBe('cancelled');
    expect(m.createDownloadPlan).not.toHaveBeenCalled();
  });

  it('asks for no plan when the answer was the archive', async () => {
    m.requestConfirmation.mockResolvedValue('zip');

    await expect(useSeparateDownload().run(ask)).resolves.toBe('zip');
    expect(m.createDownloadPlan).not.toHaveBeenCalled();
  });

  it('asks for no plan when the folder picker was closed', async () => {
    m.canWriteToChosenFolder.mockReturnValue(true);
    m.chooseDownloadFolder.mockResolvedValue(null);

    await expect(useSeparateDownload().run(ask)).resolves.toBe('cancelled');
    expect(m.createDownloadPlan).not.toHaveBeenCalled();
  });

  it('asks for no plan when nothing was selected', async () => {
    await expect(useSeparateDownload().run({ paths: [] })).resolves.toBe('cancelled');
    expect(m.requestConfirmation).not.toHaveBeenCalled();
    expect(m.createDownloadPlan).not.toHaveBeenCalled();
  });
});

describe('the way the files are taken', () => {
  it('is the anchors where there is no folder picker', async () => {
    await expect(useSeparateDownload().run(ask)).resolves.toBe('done');

    expect(m.clickPartsThrough).toHaveBeenCalledWith({ plan: CARRIED });
    expect(m.writePartsToFolder).not.toHaveBeenCalled();
    expect(m.startOperation).not.toHaveBeenCalled();
  });

  /** The picker exists but would not open: the other way still works. */
  it('is the anchors where the picker refused to open', async () => {
    m.canWriteToChosenFolder.mockReturnValue(true);
    m.chooseDownloadFolder.mockRejectedValue(new Error('no gesture'));

    await expect(useSeparateDownload().run(ask)).resolves.toBe('done');

    expect(m.clickPartsThrough).toHaveBeenCalled();
    expect(m.createDownloadPlan).toHaveBeenCalledWith(ask.paths, 'Docs');
  });

  it('is the chosen folder, with an operation to watch it by', async () => {
    m.canWriteToChosenFolder.mockReturnValue(true);
    m.chooseDownloadFolder.mockResolvedValue({ name: 'Downloads' });

    await expect(useSeparateDownload().run(ask)).resolves.toBe('done');

    expect(m.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'download', itemCount: 2, totalBytes: 10, cancellable: true })
    );
    expect(m.writePartsToFolder).toHaveBeenCalledWith(
      expect.objectContaining({ plan: CARRIED, folder: { name: 'Downloads' } })
    );
    expect(m.finishOperation).toHaveBeenCalledWith('op-1');
    expect(m.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', heading: 'download.wrote' })
    );
  });

  it('says so when a write failed, and lets the operation go', async () => {
    m.canWriteToChosenFolder.mockReturnValue(true);
    m.chooseDownloadFolder.mockResolvedValue({ name: 'Downloads' });
    m.writePartsToFolder.mockRejectedValue(new Error('the disk said no'));

    await expect(useSeparateDownload().run(ask)).resolves.toBe('failed');

    expect(m.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', heading: 'download.failed' })
    );
    expect(m.finishOperation).toHaveBeenCalledWith('op-1');
  });

  /**
   * A refusal by the server has already been reported by the API client, and
   * saying it twice reads as two things having gone wrong.
   */
  it('stays quiet about a refusal the client already reported', async () => {
    m.canWriteToChosenFolder.mockReturnValue(true);
    m.chooseDownloadFolder.mockResolvedValue({ name: 'Downloads' });
    const refused = new Error('Download not allowed.');
    refused.statusCode = 403;
    m.writePartsToFolder.mockRejectedValue(refused);

    await expect(useSeparateDownload().run(ask)).resolves.toBe('failed');

    expect(m.addNotification).not.toHaveBeenCalled();
  });
});
