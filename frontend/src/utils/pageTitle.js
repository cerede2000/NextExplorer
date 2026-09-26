/**
 * The browser tab's title: what the page is, then the name the instance was
 * given in Settings → Branding.
 *
 * It used to be the page alone — a folder's name, with nothing to say which
 * application, let alone which instance, the tab belonged to among the others
 * (nxzai/NextExplorer discussion #395). And "the page" was the last segment of
 * the path whatever the page was, so every settings section, the search and
 * both share lists read "Volumes", in English, as the home page did.
 */

/** Narrow in the tab bar, where every character of the page name counts. */
export const TITLE_SEPARATOR = ' | ';

/** The whole title, from the page's own name and the instance's. */
export const composeTitle = (page, appName) => {
  const part = String(page ?? '').trim();
  const name = String(appName ?? '').trim();
  if (part && name) return `${part}${TITLE_SEPARATOR}${name}`;
  return part || name || 'Explorer';
};

const camelCase = (key) => key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

const segmentsOf = (route) => {
  const path = route?.params?.path;
  const joined = Array.isArray(path) ? path.join('/') : path || '';
  return joined.split('/').filter(Boolean);
};

/**
 * What a page of the explorer is called, before the instance's name.
 *
 * @param {object} route
 * @param {Function} t        the translator
 * @param {object} [extras]
 * @param {Function} [extras.te]  whether a translation exists, to name a
 *   settings section only when it has a name of its own
 * @param {string} [extras.shareName]  what the share being browsed is called:
 *   at its top the address holds only its token, which names nothing
 */
export const pageTitleFor = (route, t, { te = () => false, shareName = '' } = {}) => {
  if (route?.name === 'Trash') return t('trash.title');
  if (route?.name === 'SharedWithMe') return t('share.sharedWithMe');
  if (route?.name === 'SharedByMe') return t('share.sharedByMe');

  const address = String(route?.path || '');
  if (address.startsWith('/settings')) {
    const section = address.split('/').filter(Boolean)[1] || '';
    const key = section ? `settings.categories.${camelCase(section)}` : '';
    return key && te(key) ? t(key) : t('titles.settings');
  }
  if (address.startsWith('/search')) {
    const term = String(route?.query?.q || '').trim();
    return term ? t('search.resultsFor', { q: term }) : t('actions.search');
  }

  const segments = segmentsOf(route);
  if (segments.length === 0) return t('titles.volumes');
  if (segments.length === 1 && segments[0] === 'personal') return t('drives.myfiles');
  if (segments.length === 2 && segments[0] === 'share') return shareName || t('titles.share');
  return segments[segments.length - 1];
};

/** The name of a file from its path, for the pages that show one file. */
export const fileTitleFor = (path) =>
  String(path || '')
    .split('/')
    .filter(Boolean)
    .pop() || '';
