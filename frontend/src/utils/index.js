import dayjs from 'dayjs';

function formatDate(unixTimestamp) {
  return dayjs(unixTimestamp).format('YYYY-MM-DD HH:mm:ss');
}

/**
 * Format an ISO timestamp the way the share views show it: the viewer's own
 * locale, date and time. `fallback` is returned for an empty value, and an
 * unparsable one is shown as-is rather than as "Invalid Date".
 */
function formatLocalDateTime(dateString, fallback = '') {
  if (!dateString) return fallback;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function formatBytes(bytes, decimals) {
  if (bytes == 0) return '0 Bytes';
  var k = 1024,
    dm = decimals || 2,
    sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
    i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function withViewTransition(func) {
  return function (...args) {
    if (!document.startViewTransition) {
      func(...args);
      return;
    }
    const transition = document.startViewTransition(() => func(...args));

    // A transition that does not get to animate rejects `ready` with
    // InvalidStateError, and nothing here was listening: every navigation
    // reached the console as an unhandled rejection reading like a fault.
    // Nothing is wrong when it happens — `updateCallbackDone` and `finished`
    // both resolve, so the navigation the callback performed did happen and
    // only the animation was skipped. Those two are deliberately left alone:
    // they are where a real error in the callback would surface.
    transition?.ready?.catch(() => {});
  };
}

export { formatDate, formatLocalDateTime, formatBytes, withViewTransition };
