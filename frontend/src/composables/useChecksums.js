import { ref } from 'vue';
import { fetchKnownChecksums, takeChecksums } from '@/api';
import { useNotificationsStore } from '@/stores/notifications';
import { useOperationTasksStore } from '@/stores/operationTasks';
import { isAbortError } from '@/stores/files/items';

/**
 * What a file's bytes add up to, asked for from a panel or a menu.
 *
 * Reading a file to the end is the slowest thing the application does to one it
 * is not moving, so it is a registered operation like every other: a bar while
 * it reads, a cancel that asks the server, and a reading that survives the tab
 * being closed — the answer is waiting the next time the panel is opened,
 * because it was remembered.
 *
 * Both gestures are here because they are the same call with one difference:
 * one file, to see what it is; two or three, to learn whether they are the same
 * thing under different names.
 */
export const useChecksums = () => {
  // Reached when something is actually asked for, not when a screen is built.
  // A panel that merely shows what is already known must not need the stores an
  // operation needs — a composable that asks for them on creation makes every
  // screen that holds it depend on them.
  const operations = () => useOperationTasksStore();
  const notifications = () => useNotificationsStore();

  const running = ref(false);

  /** What is already known, without reading anything. */
  const known = async (relativePath) => {
    try {
      return await fetchKnownChecksums(relativePath);
    } catch (_) {
      // A file that cannot be asked about has nothing to show; the panel says
      // nothing rather than a refusal nobody can act on.
      return null;
    }
  };

  /**
   * Read them. `items` are `{ path, name }`, and the answer carries one entry
   * per file — plus, when comparing, whether they are the same.
   */
  const take = async (items, { compare = false, name = '' } = {}) => {
    if (running.value) return null;
    const asked = Array.isArray(items) ? items : [];
    if (asked.length === 0) return null;

    running.value = true;
    const operation = operations().startServerOperation({
      type: 'checksum',
      itemCount: asked.length,
      name: name || (asked.length === 1 ? asked[0]?.name || '' : ''),
    });

    try {
      return await takeChecksums(asked, {
        compare,
        onEvent: operation.onEvent,
        onTask: operation.onTask,
      });
    } catch (error) {
      if (!isAbortError(error)) throw error;
      return null;
    } finally {
      operation.finish();
      running.value = false;
    }
  };

  /**
   * Two or three files, and whether they are the same thing.
   *
   * Said as a notification rather than drawn somewhere, because the answer is
   * one word and the question was asked from a menu. The digests themselves are
   * remembered, so each file's own panel shows them without reading again.
   */
  const compare = async (items, { t }) => {
    const answer = await take(items, { compare: true });
    if (!answer) return null;

    const names = (Array.isArray(answer.items) ? answer.items : []).map((entry) => entry.name);
    notifications().addNotification({
      type: answer.identical ? 'success' : 'info',
      heading: answer.identical ? t('checksums.same') : t('checksums.different'),
      body: answer.because === 'size' ? t('checksums.differentSizes') : names.join(' · '),
      durationMs: 10000,
    });
    return answer;
  };

  return { running, known, take, compare };
};
