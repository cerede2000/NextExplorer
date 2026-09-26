import { waitForOnlyOfficeActivityVersion } from '@/api';

/**
 * Keeping the "being edited" marks in a listing current.
 *
 * The server holds the request open until somebody joins or leaves a document,
 * so this costs nothing while nothing happens — which is what makes presence
 * affordable to show at all. A hidden tab stops asking entirely.
 *
 * @param {object} options
 * @param {object} options.featuresStore
 * @param {() => Promise<unknown>} options.refresh  list the current folder again
 */
export const useOnlyOfficeActivity = ({ featuresStore, refresh }) => {
  let activityVersion = null;
  let started = false;
  let pollController = null;
  let visibilityHandlerBound = false;

  const waitForVisibility = () =>
    new Promise((resolve) => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        resolve();
        return;
      }
      document.addEventListener('visibilitychange', resolve, { once: true });
    });

  const start = async () => {
    if (started || typeof window === 'undefined') return;

    // The route only exists where ONLYOFFICE is configured, so asking for it
    // anywhere else is a 404 — answered at once, retried a second later, for as
    // long as the tab stays open. Every one of them is logged server-side with
    // a stack trace, and the mark it feeds cannot show anything without a
    // Document Server anyway.
    await featuresStore.ensureLoaded();
    if (!featuresStore.onlyofficeEnabled) return;
    // Another navigation may have got here while features were loading.
    if (started) return;
    started = true;

    const poll = async () => {
      while (started) {
        await waitForVisibility();
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
          if (changed) await refresh();
        } catch (error) {
          if (error?.name !== 'AbortError') {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } finally {
          if (pollController === controller) pollController = null;
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

  const stop = () => {
    started = false;
    pollController?.abort();
  };

  return { start, stop };
};
