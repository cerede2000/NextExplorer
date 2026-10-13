import { onMounted, onScopeDispose, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { fetchUnfinishedUploads, forgetTaskNews, normalizePath } from '@/api';
import { guestSessionId } from '@/api/guestSession';
import { useAuthStore } from '@/stores/auth';
import { useFileStore } from '@/stores/fileStore';
import { useNotificationsStore } from '@/stores/notifications';
import { useOperationTasksStore } from '@/stores/operationTasks';

/**
 * Taking up the operations this reader already has running, and giving them the
 * news about the ones they were not here for.
 *
 * A long operation runs in the server, not in the tab that asked for it: closing
 * the tab no longer stops one. Two halves follow from that, and both are here.
 *
 * A tab opened afterwards knew nothing about what was still running, so a
 * transfer of twenty gigabytes was invisible until it was over. So the
 * application asks, once it knows who is reading, and follows what it finds from
 * wherever each one has got to.
 *
 * And an operation that outlives its tab also *ends* out of sight. An end nobody
 * saw is an end nobody was told about — including a failure, which is the one
 * worth most — so the server keeps what became of it and hands it over here. A
 * restart is the third case: nothing is resumed across one, deliberately, since
 * half a copy is a state on disk and taking it up again would mean deciding
 * about what is already there; what was in flight is kept as news instead, with
 * the paths.
 *
 * One notification per piece of news, not per operation: five finished copies
 * are one line and five items, where five notifications are five things to
 * dismiss.
 *
 * And the uploads that did not arrive, which are news of the same kind told a
 * different way. An upload cannot be taken over by the server — the bytes are in
 * the browser — so there is nothing to adopt and nothing to acknowledge: the
 * file is either finished or it is not. What the reader needs is to know, which
 * is said once per tab for as long as the server is still holding the part that
 * arrived.
 */
const UPLOADS_TOLD = 'nextExplorer_unfinished_uploads_told';
const KIND_LABELS = {
  copy: 'transfers.newsKindCopy',
  move: 'transfers.newsKindMove',
  delete: 'transfers.newsKindDelete',
  extract: 'transfers.newsKindExtract',
  compress: 'transfers.newsKindCompress',
  restore: 'transfers.newsKindRestore',
  checksum: 'transfers.newsKindChecksum',
};

export const useAdoptedOperations = () => {
  const auth = useAuthStore();
  const fileStore = useFileStore();
  const notifications = useNotificationsStore();
  const operations = useOperationTasksStore();
  const { t } = useI18n();

  /** Whoever is reading: an account, or a visitor carrying a share's session. */
  const somebodyIsReading = () => auth.isAuthenticated || Boolean(guestSessionId.value);

  /**
   * One line for one operation: what it was, and where it was going.
   *
   * Put together with an arrow rather than a sentence, because a sentence needs
   * a preposition and every language puts it somewhere else.
   */
  const lineFor = (report) => {
    const label = t(KIND_LABELS[report.kind] || 'transfers.newsKindOther');
    const about = report.name || report.destination || '';
    return about ? `${label} → ${about}` : label;
  };

  const tell = (type, headingKey, reports, extra = []) => {
    if (reports.length === 0) return;
    notifications.addNotification({
      type,
      heading: t(headingKey, { count: reports.length }, reports.length),
      body: [...extra, reports.map(lineFor).join(' · ')].filter(Boolean).join(' '),
      durationMs: type === 'error' ? 15000 : 10000,
    });
  };

  const tellTheNews = ({ interrupted, unreported }) => {
    const paths = interrupted.flatMap((report) =>
      Array.isArray(report.paths) ? report.paths : []
    );
    tell('warning', 'transfers.interruptedHeading', interrupted, [
      t('transfers.interruptedBody'),
      paths.length ? t('transfers.interruptedCarrying', { paths: paths.join(', ') }) : '',
    ]);
    tell(
      'success',
      'transfers.finishedHeading',
      unreported.filter((report) => report.outcome === 'done')
    );
    tell(
      'error',
      'transfers.failedHeading',
      unreported.filter((report) => report.outcome === 'failed')
    );
  };

  /**
   * Which of these has already been said in this tab.
   *
   * Session storage, so a reload says nothing again and tomorrow's tab says it
   * once — which is right: the file still has not arrived. A browser that
   * refuses storage simply gets told again, which is the safe way round.
   */
  const alreadyTold = () => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(UPLOADS_TOLD) || '[]'));
    } catch (_) {
      return new Set();
    }
  };

  const rememberTold = (ids) => {
    try {
      sessionStorage.setItem(UPLOADS_TOLD, JSON.stringify([...ids]));
    } catch (_) {
      /* nothing kept, so it will be said again */
    }
  };

  const howFar = (upload) => {
    const size = Number(upload.size);
    const offset = Number(upload.offset);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(offset)) return upload.name;
    return `${upload.name} (${Math.min(99, Math.floor((offset / size) * 100))}%)`;
  };

  const tellAboutUploads = async () => {
    const unfinished = await fetchUnfinishedUploads();
    const told = alreadyTold();
    const fresh = unfinished.filter((upload) => !told.has(upload.id));
    // Still kept from this tab's own telling: an upload that has since arrived
    // is one less thing remembered.
    rememberTold(unfinished.map((upload) => upload.id));
    if (fresh.length === 0) return;

    notifications.addNotification({
      type: 'warning',
      heading: t('upload.notArrivedHeading', { count: fresh.length }, fresh.length),
      body: `${t('upload.notArrivedBody')} ${fresh.map(howFar).join(' · ')}`,
      durationMs: 15000,
    });
  };

  const look = async () => {
    if (!somebodyIsReading()) return;
    await tellAboutUploads().catch(() => {});
    try {
      const { interrupted, unreported } = await operations.adoptServerOperations();
      const news = [...interrupted, ...unreported];
      if (news.length === 0) return;
      tellTheNews({ interrupted, unreported });
      // Told once: the news is theirs to be given, not to be given again.
      await forgetTaskNews(news.map((report) => report.id)).catch(() => {});
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
      tell('success', 'transfers.finishedHeading', [{ kind, destination: landed }]);
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
