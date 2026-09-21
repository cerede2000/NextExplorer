import { getShareInfo } from '@/api/shares.api';
import { buildUrl } from '@/api/http';

/**
 * Whether a signed-in account may open a share straight away, or has to be sent
 * to its password first.
 *
 * The server asks every account but the owner for a share's password, so a
 * signed-in visitor who has not typed it is refused everything inside the share.
 * Letting them into the folder view would show refusals where the prompt
 * belongs. Whether they have typed it is known to the server only — the proof
 * is a guest session cookie the page cannot read — so it is asked, once per
 * share and account for as long as the tab is open, and only when the share
 * says this viewer needs a password at all.
 */
const verdicts = new Map();

export const resetShareGuard = () => verdicts.clear();

export const signedInMayOpenShare = async (shareToken, viewerId) => {
  const key = `${viewerId || 'anonymous'}:${shareToken}`;
  if (verdicts.get(key) === true) return true;

  let info;
  try {
    info = await getShareInfo(shareToken);
  } catch {
    // An unknown or unreachable share: the view says what is wrong with it.
    return true;
  }
  if (!info?.requiresPassword) {
    verdicts.set(key, true);
    return true;
  }

  // Asked directly rather than through the API layer, which reports every
  // refusal as an error: this one is the expected answer for somebody who has
  // not typed the password yet, and the prompt is where it leads.
  let response = null;
  try {
    response = await fetch(buildUrl(`/api/share/${encodeURIComponent(shareToken)}/access`), {
      credentials: 'include',
    });
  } catch {
    return true;
  }
  if (response.status === 401) return false;
  if (response.ok) verdicts.set(key, true);
  return true;
};
