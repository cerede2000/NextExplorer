import dayjs from 'dayjs';

function formatDate(unixTimestamp) {
  return dayjs(unixTimestamp).format('YYYY-MM-DD HH:mm:ss');
}

/** A date and time as the reader's own machine writes them. */
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
    document.startViewTransition(() => func(...args));
  };
}

export { formatDate, formatLocalDateTime, formatBytes, withViewTransition };
