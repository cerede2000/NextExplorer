const logger = require('./logger');

/**
 * What a failure nobody caught should cost.
 *
 * A single forgotten `await` ended the server. `resolvePersonalPath` checks
 * that a path is still inside the user's directory once every symbolic link has
 * been followed, and that check lives in the promise it returns; a caller that
 * did not await it left the rejection with no listener, and Node's default for
 * one of those is to raise it as an uncaught exception and stop the process. So
 * a request that should have been answered "no" answered by taking the server
 * down with it.
 *
 * That is a disproportionate price for one bad path. A rejection raised while
 * serving a request is almost always confined to that request: the connection
 * fails, and everybody else's work is untouched. Reporting it and carrying on
 * is the proportionate answer.
 *
 * An uncaught exception is not the same thing and is not treated the same way.
 * There the stack unwound through code that had no chance to put anything back,
 * so what is in memory afterwards is unknown — a lock still held, a transaction
 * half applied. Continuing to serve from that is worse than stopping, so this
 * stops, deliberately and after saying why.
 *
 * None of this hides anything from development. The test suites never load this
 * file, and the runner already fails a run that leaves an unhandled rejection
 * behind — which is exactly how the defect above was found. The quiet is bought
 * only in production, where staying up is worth more than dying loudly.
 */

/** How long a shutdown may take before it is abandoned. */
const FATAL_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * @param {object} [options]
 * @param {object} [options.log] where to report, injected so a test can read it
 * @param {() => Promise<void>|void} [options.onFatal] the ordinary shutdown, tried
 *   before giving up on an uncaught exception
 * @param {(code: number) => void} [options.exit]
 * @param {NodeJS.EventEmitter} [options.target] the process to attach to
 * @returns {() => void} removes both listeners again
 */
const installProcessFailureHandlers = ({
  log = logger,
  onFatal = null,
  exit = (code) => process.exit(code),
  shutdownTimeoutMs = FATAL_SHUTDOWN_TIMEOUT_MS,
  target = process,
} = {}) => {
  const onUnhandledRejection = (reason) => {
    // Normalised: a rejection carries whatever was thrown, which is often an
    // Error and sometimes a string nobody meant to reject with.
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error(
      { err },
      'A promise was rejected with nobody listening. The request behind it has failed; the server has not.'
    );
  };

  const onUncaughtException = (error) => {
    log.error(
      { err: error },
      'Uncaught exception. Shutting down: what is in memory after this cannot be trusted.'
    );

    // Bounded, because the shutdown runs in the same unknown state and may
    // never finish. Whichever comes first wins, and the process ends either way.
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      exit(1);
    };

    const timer = setTimeout(end, shutdownTimeoutMs);
    timer.unref?.();

    Promise.resolve()
      .then(() => onFatal?.())
      .catch((shutdownError) => {
        log.error({ err: shutdownError }, 'Shutdown after an uncaught exception failed too');
      })
      .finally(() => {
        clearTimeout(timer);
        end();
      });
  };

  target.on('unhandledRejection', onUnhandledRejection);
  target.on('uncaughtException', onUncaughtException);

  return () => {
    target.off('unhandledRejection', onUnhandledRejection);
    target.off('uncaughtException', onUncaughtException);
  };
};

module.exports = { installProcessFailureHandlers, FATAL_SHUTDOWN_TIMEOUT_MS };
