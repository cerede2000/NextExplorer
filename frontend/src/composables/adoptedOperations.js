import { onMounted, onScopeDispose, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { forgetInterruptedTasks, normalizePath } from '@/api';
import { guestSessionId } from '@/api/guestSession';
import { useAuthStore } from '@/stores/auth';
import { useFileStore } from '@/stores/fileStore';
import { useNotificationsStore } from '@/stores/notifications';
import { useOperationTasksStore } from '@/stores/operationTasks';

/**
 * Taking up the operations this reader already has running, and saying what a
 * restart took.
 *
 * A copy or a move runs in the server, not in the tab that asked for it: closing
 * the tab no longer stops one. What was missing is the other half — a tab opened
 * afterwards knew nothing about it, so a transfer of twenty gigabytes was
 * invisible until it was over. So the application asks, once it knows who is
 * reading, and follows what it finds from wherever each one has got to.
 *
 * Nothing is resumed across a restart, deliberately: half a copy is a state on
 * disk, and picking it up would mean deciding about what is already there. What
 * the server kept instead is a record of what was in flight, with the paths, and
 * it is handed over once — so the person who started it is told, rather than left
 * to find half of it at the destination.
 */
const HEADINGS = {
  interrupted: {
    copy: 'transfers.interruptedCopy',
    move: 'transfers.interruptedMove',
    other: 'transfers.interruptedOther',
  },
  finished: {
    copy: 'transfers.finishedCopy',
    move: 'transfers.finishedMove',
    other: 'transfers.finishedOther',
  },
};

const headingFor = (group, kind) => HEADINGS[group]?.[kind] || HEADINGS[group].other;

export const useAdoptedOperations = () => {
  const auth = useAuthStore();
  const fileStore = useFileStore();
  const notifications = useNotificationsStore();
  const operations = useOperationTasksStore();
  const { t } = useI18n();

  /** Whoever is reading: an account, or a visitor carrying a share's session. */
  const somebodyIsReading = () => auth.isAuthenticated || Boolean(guestSessionId.value);

  const tellAboutInterrupted = (report) => {
    const paths = Array.isArray(report.paths) ? report.paths : [];
    notifications.addNotification({
      type: 'warning',
      heading: t(headingFor('interrupted', report.kind)),
      body: [
        t('transfers.interruptedBody', { destination: report.destination }),
        paths.length ? t('transfers.interruptedCarrying', { paths: paths.join(', ') }) : '',
      ]
        .filter(Boolean)
        .join(' '),
      durationMs: 12000,
    });
  };

  const look = async () => {
    if (!somebodyIsReading()) return;
    try {
      const { interrupted } = await operations.adoptServerOperations();
      if (interrupted.length === 0) return;
      for (const report of interrupted) tellAboutInterrupted(report);
      // Told once: the record is theirs to be given, not to be given again.
      await forgetInterruptedTasks(interrupted.map((report) => report.id)).catch(() => {});
    } catch (_) {
      // Nothing to show is not worth a refusal on the screen: whatever is
      // running will be found at the next look.
    }
  };

  // The folder on screen is the one that just filled up, so it is refreshed —
  // and only it: a reader who walked away mid-transfer is not sent back.
  const stopListening = operations.whenAdoptedSettles(({ kind, destination, result, error }) => {
    const landed = normalizePath(result?.destination || destination || '');
    if (!error) {
      notifications.addNotification({
        type: 'success',
        heading: t(headingFor('finished', kind)),
        body: t('transfers.finishedBody', { destination: landed }),
      });
    }
    if (landed && normalizePath(fileStore.currentPath || '') === landed) {
      fileStore.fetchPathItems(landed);
      fileStore.refreshSizes?.();
    }
  });
  // The store outlives any one screen, so what it holds for this one is given
  // back with it.
  onScopeDispose(() => stopListening());

  onMounted(look);
  // And again when somebody signs in, or types a share's password, which is when
  // the first look found nobody to ask on behalf of.
  watch(
    () => Boolean(auth.isAuthenticated || guestSessionId.value),
    (reading, wasReading) => {
      if (reading && !wasReading) look();
    }
  );

  return { look };
};
