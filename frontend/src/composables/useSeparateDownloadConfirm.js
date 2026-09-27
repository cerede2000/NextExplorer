import { computed, ref } from 'vue';

/**
 * The question asked before a selection becomes a great many downloads (#487).
 *
 * One archive is one request whatever is in it. Separate files are one request
 * each, and past a certain number that stops being a convenience: the browser
 * queues them, the folder fills with them, and whoever asked may simply not
 * have noticed how much was selected. So past that number it is asked, with the
 * archive offered as the answer — the choice, not a refusal.
 */

/** Where a selection stops being a handful. */
export const SEPARATE_DOWNLOAD_THRESHOLD = 25;

let instance = null;

export function useSeparateDownloadConfirm() {
  if (instance) return instance;

  const isOpen = ref(false);
  const pending = ref({ files: 0, folders: 0 });
  let resolvePending = null;

  const fileCount = computed(() => pending.value.files);
  const folderCount = computed(() => pending.value.folders);

  const settle = (answer) => {
    if (!resolvePending) return;
    const resolve = resolvePending;
    resolvePending = null;
    isOpen.value = false;
    pending.value = { files: 0, folders: 0 };
    resolve(answer);
  };

  /**
   * Resolves with what to do: 'separate', 'zip', or null for neither.
   *
   * A selection below the threshold is not worth a dialog, and answers itself.
   */
  const requestConfirmation = ({ files = 0, folders = 0 } = {}) => {
    if (files <= SEPARATE_DOWNLOAD_THRESHOLD) return Promise.resolve('separate');

    // A second question replaces the one on screen, and the first must not be
    // left unanswered: whoever is waiting on it is holding a download that will
    // never start. It is answered as neither.
    if (resolvePending) settle(null);

    pending.value = { files, folders };
    isOpen.value = true;

    return new Promise((resolve) => {
      resolvePending = resolve;
    });
  };

  instance = {
    isOpen,
    fileCount,
    folderCount,
    requestConfirmation,
    cancel: () => settle(null),
    chooseSeparate: () => settle('separate'),
    chooseZip: () => settle('zip'),
  };
  return instance;
}
