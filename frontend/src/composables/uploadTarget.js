import { apiBase } from '@/api';

/**
 * Where a file is going, and whether it may go there.
 *
 * Three decisions lifted out of the uploader, which is 820 lines holding seven
 * stores and was measured at two per cent covered. These are the ones where
 * being wrong is visible from outside: a file lands in the wrong folder, a
 * folder upload loses its tree, or somebody is refused an upload they were
 * entitled to — or worse, allowed one they were not.
 *
 * They take what they need as arguments rather than reading it from a store, so
 * a test can state the situation instead of assembling it.
 */

/** The keys the server reads from the query, and the only ones sent. */
const UPLOAD_META_KEYS = ['uploadTo', 'relativePath', 'resolvedRelativePath', 'uploadBatchId'];

/**
 * The endpoint a direct upload posts to.
 *
 * Everything that decides the destination travels in the query, so a wrong
 * answer here puts the file somewhere nobody asked for. Only the four keys the
 * server reads are sent, and only when they carry something: an empty value in
 * the query is not the same as its absence.
 */
export const directUploadEndpoint = (file) => {
  const meta = file?.meta || {};
  const params = new URLSearchParams();

  UPLOAD_META_KEYS.forEach((key) => {
    if (typeof meta[key] === 'string' && meta[key]) params.set(key, meta[key]);
  });

  const query = params.toString();
  return query ? `${apiBase}/api/upload?${query}` : `${apiBase}/api/upload`;
};

/**
 * The path a file carries inside a dropped folder, or null when it is a file
 * on its own.
 *
 * A browser reports it in one of three places depending on how the file
 * arrived — the meta the uploader set, the `webkitRelativePath` a folder input
 * gives, or nothing at all, leaving only the name. A single segment is a file
 * with no folder around it, which is why the length is what decides rather
 * than the presence of a path.
 */
export const folderUploadParts = (file) => {
  const relativePath =
    file?.meta?.relativePath || file?.data?.webkitRelativePath || file?.name || '';
  const parts = String(relativePath).split('/').filter(Boolean);
  return parts.length > 1 ? parts : null;
};

/** Why an upload was refused, so the caller can say it in the reader's language. */
export const UPLOAD_BLOCKED = {
  shareLoading: 'shareLoading',
  shareReadOnly: 'shareReadOnly',
  notPermitted: 'notPermitted',
};

/**
 * Whether this location accepts an upload, and why not when it does not.
 *
 * The decision and its explanation used to be two functions reading the same
 * two values and stating the same rule twice — the sort of pair that agrees
 * until somebody changes one of them.
 *
 * A share whose metadata has not arrived fails closed. Anywhere else, an
 * unknown state is the ordinary case before a listing loads and must not stop
 * somebody uploading into their own folder.
 */
export const uploadPermission = (access, currentPath = '') => {
  if (!access) {
    return String(currentPath || '').startsWith('share/')
      ? { allowed: false, reason: UPLOAD_BLOCKED.shareLoading }
      : { allowed: true, reason: null };
  }

  if (access.canUpload === false) {
    return {
      allowed: false,
      reason:
        access.shareInfo?.accessMode === 'readonly'
          ? UPLOAD_BLOCKED.shareReadOnly
          : UPLOAD_BLOCKED.notPermitted,
    };
  }

  return { allowed: true, reason: null };
};

/**
 * The refusal in words.
 *
 * Kept in one place and in English, which is what the uploader has always
 * shown: nothing here is translated yet, while the rest of the application is
 * in fourteen languages. Separating the reason from its wording is what makes
 * that fixable without touching the decision.
 */
export const uploadBlockedMessage = (reason) => {
  if (reason === UPLOAD_BLOCKED.shareLoading) {
    return 'Share is still loading. Please try again in a moment.';
  }
  if (reason === UPLOAD_BLOCKED.shareReadOnly) {
    return 'This share is read-only. Uploads are disabled.';
  }
  return 'You do not have permission to upload to this location.';
};
