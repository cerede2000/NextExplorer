/**
 * What the terminal is opened with for a file: its extension, to decide
 * whether it is something a shell runs, and the command line that runs it.
 */

/** The extension, lower case; the kind the server reported when there is none. */
export const itemExtension = (item) => {
  const name = String(item?.name || '');
  const lastDot = name.lastIndexOf('.');
  if (lastDot > 0 && lastDot < name.length - 1) {
    return name.slice(lastDot + 1).toLowerCase();
  }

  const kind = String(item?.kind || '').toLowerCase();
  return kind && kind !== 'file' && kind !== 'directory' && kind !== 'volume' ? kind : '';
};

const shellEscape = (value) => String(value).replace(/([^A-Za-z0-9_@%+=:,./-])/g, '\\$1');

/** `./name`, quoted so a shell does not split or expand it. */
export const terminalInputFor = (item) => {
  const name = String(item?.name || '').trim();
  if (!name) return '';

  return shellEscape(`./${name}`);
};
