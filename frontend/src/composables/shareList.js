import { computed, ref } from 'vue';

/**
 * Filtering, searching and ordering a list of share links.
 *
 * Both share screens want exactly this, and both had their own copy. They are
 * not identical copies, which is the reason for the parameters: one list is
 * searched by the name of the file a link points at and the other by its path,
 * and "most recent" counts a download on the links you handed out but has
 * nothing to count on the ones you received.
 *
 * An extraction that assumed the duplication was exact would have quietly
 * flattened both of those.
 *
 * @param {import('vue').Ref<Array>} shares
 * @param {object} options
 * @param {(share: object) => string} options.labelOf what a link is called —
 *   searched, and what sorting by name sorts by
 * @param {(share: object) => string} options.searchAlso the other thing worth
 *   typing to find a link: where it points
 * @param {string[]} options.recentFields the fields that can hold "when
 *   something last happened to this link", most meaningful first
 */
export const useShareList = (shares, { labelOf, searchAlso, recentFields }) => {
  const filterMode = ref('active'); // 'active' | 'expired' | 'all'
  const sortMode = ref('recent'); // 'recent' | 'label'
  const searchQuery = ref('');

  const isExpired = (share) => {
    if (!share?.expiresAt) return false;
    return new Date(share.expiresAt) <= new Date();
  };

  const recentTimestamp = (share) => {
    if (!share) return 0;
    for (const field of recentFields) {
      const raw = share[field];
      if (!raw) continue;
      const time = new Date(raw).getTime();
      if (!Number.isNaN(time)) return time;
    }
    return 0;
  };

  const visibleShares = computed(() => {
    let list = shares.value.slice();

    if (filterMode.value === 'active') list = list.filter((share) => !isExpired(share));
    else if (filterMode.value === 'expired') list = list.filter((share) => isExpired(share));

    const term = searchQuery.value.trim().toLowerCase();
    if (term) {
      list = list.filter((share) => {
        const label = (labelOf(share) || '').toLowerCase();
        const other = (searchAlso(share) || '').toLowerCase();
        return label.includes(term) || other.includes(term);
      });
    }

    list.sort((a, b) => {
      if (sortMode.value === 'label') return labelOf(a).localeCompare(labelOf(b));
      return recentTimestamp(b) - recentTimestamp(a);
    });

    return list;
  });

  return { filterMode, sortMode, searchQuery, isExpired, visibleShares };
};
