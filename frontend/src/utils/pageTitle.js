/**
 * The browser tab's title for a page of the explorer: the folder being looked
 * at, or what the page is when it is not a folder.
 *
 * A page without a path used to fall back on "Volumes" whatever it was, so the
 * trash read as the volume list in the tab bar and in the history.
 */
export const pageTitleFor = (route, t) => {
  if (route?.name === 'Trash') return t('trash.title');
  const path = route?.params?.path;
  const joined = Array.isArray(path) ? path.join('/') : path || '';
  return joined.split('/').filter(Boolean).pop() || 'Volumes';
};
