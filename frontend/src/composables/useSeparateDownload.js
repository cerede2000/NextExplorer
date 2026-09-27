import i18n from '@/i18n';
import { createDownloadPlan } from '@/api';
import { useNotificationsStore } from '@/stores/notifications';
import { useOperationTasksStore } from '@/stores/operationTasks';
import { useSeparateDownloadConfirm } from '@/composables/useSeparateDownloadConfirm';
import {
  canWriteToChosenFolder,
  chooseDownloadFolder,
  clickPartsThrough,
  knownTotalBytes,
  partsOf,
  writePartsToFolder,
} from '@/composables/separateDownloads';

/**
 * Downloading a selection as separate files, from the question to the last byte.
 *
 * The order the steps are in is the point of this file. Asking the server for a
 * plan is what counts the download — once, for the whole selection, as a zip
 * would be — so everything that could still end in nothing happens first: the
 * question about a large selection, and the folder picker. A plan is made only
 * once the answer is yes.
 */
export function useSeparateDownload() {
  const notifications = useNotificationsStore();
  const operationTasks = useOperationTasksStore();
  const confirm = useSeparateDownloadConfirm();

  /**
   * @returns {'done'|'zip'|'cancelled'|'failed'} — 'zip' is the caller's cue to
   * download the same selection as one archive instead, which is what the
   * question offers and what a browser with no picker may still be better at.
   */
  const run = async ({ paths, basePath = '', fileCount = 0, folderCount = 0 } = {}) => {
    if (!Array.isArray(paths) || paths.length === 0) return 'cancelled';

    const answer = await confirm.requestConfirmation({ files: fileCount, folders: folderCount });
    if (!answer) return 'cancelled';
    if (answer === 'zip') return 'zip';

    // Closing the picker and the picker refusing to open are not the same
    // answer. Somebody who closed it did not ask for their downloads folder to
    // fill up instead, so that stops here; a picker that would not open — no
    // gesture behind the call, or a policy — leaves the other way, which works.
    let folder = null;
    if (canWriteToChosenFolder()) {
      let closedIt = false;
      try {
        folder = await chooseDownloadFolder();
        closedIt = folder === null;
      } catch (_) {
        folder = null;
      }
      if (closedIt) return 'cancelled';
    }

    // From here the download is counted, so from here it has to be reported.
    const plan = await createDownloadPlan(paths, basePath);
    if (!plan?.token || (!plan.files?.length && !plan.archive)) return 'failed';

    if (!folder) {
      await clickPartsThrough({ plan });
      return 'done';
    }

    return writeIntoFolder(plan, folder);
  };

  const writeIntoFolder = async (plan, folder) => {
    const { t } = i18n.global;
    const controller = new AbortController();
    const totalBytes = knownTotalBytes(plan);
    const totalParts = partsOf(plan).length;

    const operationId = operationTasks.startOperation({
      type: 'download',
      itemCount: totalParts,
      destination: folder.name || '',
      totalBytes,
      copiedBytes: 0,
      cancellable: true,
      cancel: () => controller.abort(),
    });

    try {
      const { renamed } = await writePartsToFolder({
        plan,
        folder,
        signal: controller.signal,
        onProgress: ({ writtenBytes, finishedParts }) => {
          // Bytes where every part has a length, parts where one of them is an
          // archive being built as it is sent.
          operationTasks.updateOperation(
            operationId,
            totalBytes > 0
              ? { copiedBytes: writtenBytes }
              : { percent: Math.round((finishedParts / totalParts) * 100) }
          );
        },
      });

      if (controller.signal.aborted) return 'cancelled';

      notifications.addNotification({
        type: 'success',
        heading: t('download.wrote', { count: totalParts, folder: folder.name || '' }),
        body: renamed.length ? t('download.renamed', { count: renamed.length }) : undefined,
      });
      return 'done';
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return 'cancelled';

      // A refusal by the API has already been reported by the client itself;
      // everything else — a folder that turned the write away, a name with no
      // free spelling left — has not been reported by anybody.
      if (!error?.statusCode) {
        notifications.addNotification({
          type: 'error',
          heading: t('download.failed'),
          body: error?.message || '',
        });
      }
      return 'failed';
    } finally {
      operationTasks.finishOperation(operationId);
    }
  };

  return { run };
}
