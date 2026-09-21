import { computed } from 'vue';
import { formatBytes } from '@/utils';

/**
 * What the delete confirmation says, from what is about to be deleted and
 * what the server said would become of it.
 *
 * Kept apart from the menu that opens the dialog: it is the part of the menu
 * that a person reads before losing something, and every sentence here has a
 * case where saying the wrong one is worse than saying nothing — calling a
 * deletion irreversible when it goes to the trash, or the other way round.
 */

const TRASH_REASON_KEYS = {
  'other-device': 'otherDevice',
  'too-large': 'tooLarge',
  'zone-root': 'zoneRoot',
  'zone-unwritable': 'zoneUnwritable',
  'no-zone': 'noZone',
  'inside-zone': 'noZone',
  disabled: 'disabled',
};

export const trashReasonKey = (reason) => TRASH_REASON_KEYS[reason] || 'noZone';

/**
 * @param {object} options
 * @param {(key: string, params?: object, plural?: number) => string} options.t
 * @param {{ trashEnabled?: boolean, trashRetentionDays?: number }} options.featuresStore
 * @param {object} options.confirm  what `useDeleteConfirm()` returns
 */
export const useDeleteDialogWording = ({ t, featuresStore, confirm }) => {
  const { pendingDeleteItems, trashPlan, isLoadingDeleteImpact, deleteImpact, keptItems } = confirm;

  const deleteDialogTitle = computed(() => {
    const count = pendingDeleteItems.value.length;
    if (count === 1 && pendingDeleteItems.value[0]) {
      return t('context.deleteTitle.single', { name: pendingDeleteItems.value[0].name });
    }
    if (count > 1) {
      return t('context.deleteTitle.multiple', { count });
    }
    return t('context.deleteTitle.generic');
  });

  /**
   * While the server has not said yet what the trash will do, the dialog must not
   * call a deletion irreversible when the trash is on: it would be wrong for
   * nearly every item. The trash wording stands until the answer arrives, and
   * the notice and buttons follow the answer as soon as it does. A click before
   * then sends a plain request, which the server sends to the trash or keeps.
   */
  const provisionalTrash = computed(
    () => !trashPlan.value && isLoadingDeleteImpact.value && featuresStore.trashEnabled === true
  );

  const deleteDialogMessage = computed(() => {
    const count = pendingDeleteItems.value.length;
    const plan = provisionalTrash.value
      ? { enabled: true, permanent: [], retentionDays: featuresStore.trashRetentionDays }
      : trashPlan.value;
    // Everything goes to the trash: say so, and for how long it is kept.
    if (plan?.enabled && count > 0 && plan.permanent.length === 0) {
      const days = plan.retentionDays ?? 0;
      if (count === 1 && pendingDeleteItems.value[0]) {
        return t(
          'context.deleteMessage.trashSingle',
          { name: pendingDeleteItems.value[0].name, count: days },
          days
        );
      }
      return t('context.deleteMessage.trashMultiple', { items: count, count: days }, days);
    }
    if (count === 1 && pendingDeleteItems.value[0]) {
      return t('context.deleteMessage.single', { name: pendingDeleteItems.value[0].name });
    }
    if (count > 1) {
      return t('context.deleteMessage.multiple', { count });
    }
    return t('context.deleteMessage.generic');
  });

  /** Which items will be gone for good although the trash is on, and why. */
  const deletePermanentNotice = computed(() => {
    const plan = trashPlan.value;
    if (!plan?.enabled || plan.permanent.length === 0) return '';
    const count = plan.permanent.length;
    const reasons = plan.reasons.map((reason) =>
      t(`context.trashReasons.${trashReasonKey(reason)}`)
    );
    return [t('context.deleteSomePermanent', { count }, count), ...reasons].join(' ');
  });

  /**
   * The part of a deletion that nothing on screen shows.
   *
   * A file is one line in the folder and its earlier versions are none, so
   * "delete" reads as one thing going when it can be ten. Only for what is not
   * coming back: into the trash a file keeps its history and gets it back.
   */
  const deleteVersionsNotice = computed(() => {
    const plan = trashPlan.value;
    const count = Number(plan?.versions) || 0;
    if (count === 0) return '';
    return t(
      'context.deleteVersionsNotice',
      { count, size: formatBytes(plan.versionBytes || 0) },
      count
    );
  });

  const goesToTrash = computed(() =>
    Boolean(
      provisionalTrash.value || (trashPlan.value?.enabled && trashPlan.value.toTrash.length > 0)
    )
  );

  const keptDialogMessage = computed(() =>
    t('context.keptMessage', { count: keptItems.value.length }, keptItems.value.length)
  );

  const keptItemReason = (item) => {
    const key = trashReasonKey(item.reason);
    if (key === 'tooLarge' && Number.isFinite(item.size) && Number.isFinite(item.budgetBytes)) {
      return t('context.keptReasons.tooLarge', {
        size: formatBytes(item.size),
        budget: formatBytes(item.budgetBytes),
      });
    }
    return t(`context.trashReasons.${key}`);
  };

  /**
   * What becomes of the share links of what is about to go. Into the trash they
   * stop working but can come back with a restore; deleted for good, they go for
   * good. The server says, per item, which it will be and how many links it has.
   */
  const deleteShareImpactMessage = computed(() => {
    const count = Number(deleteImpact.value?.shareCount || 0);
    if (count <= 0) return '';
    const planned = deleteImpact.value?.trash?.items;
    const linksGoing = (toTrash) =>
      (Array.isArray(planned) ? planned : [])
        .filter((entry) => (entry?.disposition === 'trash') === toTrash)
        .reduce((total, entry) => total + (Number(entry?.shareCount) || 0), 0);
    const suspended = linksGoing(true);
    const removed = linksGoing(false);
    if (suspended + removed === 0) return t('context.deleteLinkedShares', { count });
    return [
      suspended > 0 ? t('context.deleteLinkedSharesTrash', { count: suspended }, suspended) : '',
      removed > 0 ? t('context.deleteLinkedSharesPermanent', { count: removed }, removed) : '',
    ]
      .filter(Boolean)
      .join(' ');
  });

  const deleteOnlyOfficeActivityMessage = computed(() => {
    const activeItems = pendingDeleteItems.value.filter((item) => item?.onlyofficeActivity?.active);
    if (activeItems.length === 0) return '';
    const names = activeItems
      .slice(0, 2)
      .map((item) => item.name)
      .join(', ');
    const remaining = activeItems.length - Math.min(activeItems.length, 2);
    const subject = `${names}${remaining > 0 ? ` et ${remaining} autre(s)` : ''}`;
    return `${subject} ${activeItems.length > 1 ? 'sont ouverts' : 'est ouvert'} dans OnlyOffice. La suppression reste possible, mais une modification non enregistrée peut être perdue.`;
  });

  return {
    deleteDialogTitle,
    deleteDialogMessage,
    deletePermanentNotice,
    deleteVersionsNotice,
    goesToTrash,
    keptDialogMessage,
    keptItemReason,
    deleteShareImpactMessage,
    deleteOnlyOfficeActivityMessage,
  };
};
