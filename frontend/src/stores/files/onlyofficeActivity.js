import { waitForOnlyOfficeActivityVersion } from '@/api';
import i18n from '@/i18n';
import { isAbortError } from './items';

const waitForDocumentVisibility = () =>
  new Promise((resolve) => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      resolve();
      return;
    }
    document.addEventListener('visibilitychange', resolve, { once: true });
  });

/**
 * Keeping the "being edited in ONLYOFFICE" badges current.
 *
 * @param {object} options
 * @param {object} options.featuresStore
 * @param {() => boolean} options.isBrowsing  a listing request is in flight
 * @param {() => Promise<unknown>} options.refresh  list the current folder again
 */
export const createOnlyofficeActivityPolling = ({ featuresStore, isBrowsing, refresh }) => {
  let activityVersion = null;
  let started = false;
  let pollController = null;
  let visibilityHandlerBound = false;

  const start = async () => {
    if (started || typeof window === 'undefined') return;

    // The backend only mounts this endpoint where ONLYOFFICE is configured, so
    // asking for it anywhere else is a 404 — answered immediately, retried a
    // second later, for as long as the tab stays open. Every one of them is
    // logged server-side with a full stack trace, and the badge it feeds cannot
    // show anything without a document server anyway.
    await featuresStore.ensureLoaded();
    if (!featuresStore.onlyofficeEnabled) return;
    // Another navigation may have got here while features were loading.
    if (started) return;

    started = true;

    const poll = async () => {
      while (started) {
        await waitForDocumentVisibility();
        if (!started) return;

        const controller = new AbortController();
        pollController = controller;
        try {
          const response = await waitForOnlyOfficeActivityVersion(activityVersion, {
            signal: controller.signal,
          });
          const nextVersion = Number(response?.version);
          const changed =
            Number.isInteger(nextVersion) &&
            activityVersion !== null &&
            nextVersion !== activityVersion;
          if (Number.isInteger(nextVersion)) activityVersion = nextVersion;

          // A normal listing request is authoritative and must not be aborted
          // just to render a presence badge. The next activity change will
          // catch up after navigation settles.
          if (changed && !isBrowsing()) {
            await refresh();
          }
        } catch (error) {
          if (!isAbortError(error)) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } finally {
          if (pollController === controller) {
            pollController = null;
          }
        }
      }
    };

    if (!visibilityHandlerBound && typeof document !== 'undefined') {
      visibilityHandlerBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') pollController?.abort();
      });
    }
    void poll();
  };

  return { start };
};

/**
 * ONLYOFFICE activity is advisory by design. A document can remain safe to
 * copy, move, rename or delete, but the user deserves a clear heads-up that
 * an editor may save a newer revision shortly afterwards.
 *
 * @returns {(items: Array, action: string) => boolean} whether it warned
 */
export const createOnlyofficeWarning = (notificationsStore) => (items, action) => {
  const activeItems = (Array.isArray(items) ? items : []).filter(
    (item) => item?.onlyofficeActivity?.active
  );
  if (activeItems.length === 0) return false;

  const { t } = i18n.global;
  const names = activeItems
    .slice(0, 2)
    .map((item) => item.name)
    .join(', ');
  const remaining = activeItems.length - Math.min(activeItems.length, 2);
  const label =
    remaining > 0 ? `${names} ${t('onlyoffice.andOthers', { count: remaining })}` : names;
  notificationsStore.addNotification({
    type: 'warning',
    heading: t('onlyoffice.editingHeading'),
    // vue-i18n selects the plural form from the third argument, not from a
    // named one: the message uses its native "singular | plural" syntax.
    body: t(
      'onlyoffice.editingBody',
      { names: label, action: t(`onlyoffice.action${action}`) },
      activeItems.length
    ),
    durationMs: 8000,
  });
  return true;
};
