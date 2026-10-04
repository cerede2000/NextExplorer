/**
 * Where the logo an instance carries by default is actually served.
 *
 * It used to be `/logo.svg`, at the root, beside the icons. That is a path of
 * its own in front of an authentication proxy, and somebody opening a share link
 * from outside got a refusal and a broken image where the logo belongs — so the
 * files this page needs were gathered under the one prefix the build already
 * uses.
 *
 * `/logo.svg` is still what the settings hold for "the logo we ship": the stored
 * value says which logo, not where the bytes are, and every installation made
 * before this already has it written down. Which is why this is a reading rule
 * rather than a migration.
 */
export const DEFAULT_LOGO_URL = '/assets/logo.svg';

/** What has been written down over the years to mean the logo we ship. */
const MEANS_THE_DEFAULT = new Set(['', '/logo.svg', DEFAULT_LOGO_URL]);

/** The address to draw, for a logo somebody chose or for the one we ship. */
export const brandingLogoSrc = (url) => {
  const candidate = typeof url === 'string' ? url.trim() : '';
  return MEANS_THE_DEFAULT.has(candidate) ? DEFAULT_LOGO_URL : candidate;
};
