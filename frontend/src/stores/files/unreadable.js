import i18n from '@/i18n';

/**
 * What an operation says when it could not read everything it was given.
 *
 * The server skips an entry it cannot reach rather than failing the whole
 * copy, the whole archive or the whole extraction over it — a name whose bytes
 * are not valid UTF-8, which a volume brought over from Windows is full of. The
 * skip is the right answer and the silence was not: a copy missing files,
 * reported as done, is how somebody loses the only other version of them.
 *
 * So whatever is left out is said here, once per operation, from the count the
 * answer carries. Nothing is shown when there is nothing to say.
 *
 * A move is the one that keeps its source: the original still holds the only
 * copy of what could not be read, so it is not removed, and the sentence says
 * so rather than letting somebody go looking for a folder that is still where
 * they left it.
 */
export const createUnreadableWarning = (notificationsStore) => (result) => {
  const count = Number(result?.unreadable) || 0;
  if (count <= 0) return false;

  const { t } = i18n.global;
  const sourceKept = (Array.isArray(result?.items) ? result.items : []).some(
    (item) => item?.sourceKept
  );

  notificationsStore.addNotification({
    type: 'warning',
    heading: t('transfers.unreadableHeading'),
    // vue-i18n takes the plural form from the third argument, not from a named
    // one: the messages use its own "singular | plural" syntax.
    body: [
      t('transfers.unreadableBody', { count }, count),
      sourceKept ? t('transfers.unreadableSourceKept') : '',
    ]
      .filter(Boolean)
      .join(' '),
    durationMs: 10000,
  });
  return true;
};
