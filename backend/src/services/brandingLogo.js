const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const { directories } = require('../config/index');
const logger = require('../utils/logger');
const { placeWithoutOverwrite } = require('../utils/placeWithoutOverwrite');
const settingsService = require('./settingsService');

/**
 * The custom logo, as files in `/config/logos` served at `/static/logos`.
 *
 * A logo used to be written under one fixed name per type, `custom-logo.png`,
 * over whatever held it, the moment it was chosen. Nothing could undo that:
 * the logo in use was gone before anyone pressed Save, and a PNG chosen over a
 * PNG came back at the same address, so the settings page saw no change.
 *
 * Each logo now has a name of its own. It is written under a hidden name, put
 * under its own without replacing anything, and made the logo in the settings;
 * only then is the logo it replaced removed. When any step fails, what this
 * logo wrote is removed and the logo in use stays as it was. The address
 * changes with every logo, so no browser keeps showing the last one.
 *
 * Installations that still point at a fixed name keep being served from it;
 * that file is removed like any other once a new logo replaces it.
 */

const LOGO_URL_PREFIX = '/static/logos/';

const EXTENSIONS = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

// "logo-<uuid>.png", or "logo-<uuid> (1).png" in the unlikely case its name
// was already held.
const OWN_NAME =
  /^logo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?: \(\d+\))?\.(?:svg|png|jpg)$/;

// What earlier versions wrote, one name per type. Nothing writes them now.
const LEGACY_NAMES = ['custom-logo.svg', 'custom-logo.png', 'custom-logo.jpg'];

const logoDirectory = () => path.join(directories.config, 'logos');

const logoUrlFor = (name) => `${LOGO_URL_PREFIX}${encodeURIComponent(name)}`;

/**
 * The file name behind a logo address, when the address is one of a logo this
 * application wrote into its own directory; null for anything else — the
 * default logo, an address elsewhere, or a name that is not one of ours.
 */
const ownLogoName = (url) => {
  if (typeof url !== 'string' || !url.startsWith(LOGO_URL_PREFIX)) return null;
  let name;
  try {
    name = decodeURIComponent(url.slice(LOGO_URL_PREFIX.length));
  } catch {
    return null;
  }
  return OWN_NAME.test(name) || LEGACY_NAMES.includes(name) ? name : null;
};

const removeLogoFile = async (name) => {
  try {
    await fs.unlink(path.join(logoDirectory(), name));
    logger.info({ name }, 'Removed a logo no longer in use');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    logger.warn({ err: error, name }, 'Could not remove a logo no longer in use');
  }
};

/**
 * Remove the logo a branding change replaced, once the change is stored.
 *
 * Only a file this application wrote, and never the logo now in use. The fixed
 * names earlier versions wrote go as well, since nothing will serve them again:
 * an installation that uploaded an SVG and then a PNG kept both.
 */
const forgetReplacedLogo = async (previousUrl, currentUrl) => {
  if (previousUrl === currentUrl) return;

  const names = new Set(LEGACY_NAMES);
  const previous = ownLogoName(previousUrl);
  if (previous) names.add(previous);
  names.delete(ownLogoName(currentUrl));

  await Promise.all([...names].map(removeLogoFile));
};

/**
 * Remove the logos nothing points at, once, at start.
 *
 * A logo is written, placed under a name of its own, made the logo in the
 * settings, and only then is the one it replaced removed. Two things leave a
 * file behind: a stop between the placement and the settings write, and a
 * removal that fails. Neither leaves anything that can be reached again — a
 * logo's address is the name of its file, so a file no setting names is a file
 * nobody can ask for — and at 2 MB apiece they stay until someone goes looking.
 *
 * Start is the moment to do it: nothing of ours is being placed, so a file
 * under one of our names is a finished one rather than one in flight.
 *
 * Only the names this application writes are looked at, and never the logo in
 * use. `/config/logos` is a directory on somebody's disk; whatever else is in
 * it they put there, and it is not ours to tidy — which is why the names, and
 * not the listing, decide what goes.
 */
const sweepUnreferencedLogos = async () => {
  let entries;
  try {
    entries = await fs.readdir(logoDirectory(), { withFileTypes: true });
  } catch (error) {
    // No logo has ever been uploaded: there is no directory yet.
    if (error?.code === 'ENOENT') return;
    logger.warn({ err: error }, 'Could not look for logos no longer in use');
    return;
  }

  let inUse;
  try {
    const { branding } = await settingsService.getPublicSettings();
    inUse = ownLogoName(branding?.appLogoUrl);
  } catch (error) {
    // Not knowing which logo is in use, removing any of them could remove it.
    logger.warn({ err: error }, 'Could not read the branding; leaving the logos alone');
    return;
  }

  const unreferenced = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name !== inUse && (OWN_NAME.test(name) || LEGACY_NAMES.includes(name)));

  await Promise.all(unreferenced.map(removeLogoFile));
};

/**
 * Write the image under a name of its own, and answer that name.
 *
 * The bytes go to a hidden name first — the static handler does not serve
 * one — and the file takes its name only once whole, through the placement
 * that moves on to "name (1)" rather than replace what holds the name.
 */
const writeLogoFile = async (buffer, extension) => {
  const directory = logoDirectory();
  await fs.mkdir(directory, { recursive: true });

  const id = crypto.randomUUID();
  const partial = path.join(directory, `.logo-${id}.part`);
  let created = false;
  let placed = null;

  try {
    const handle = await fs.open(partial, 'wx');
    created = true;
    try {
      await handle.writeFile(buffer);
    } finally {
      await handle.close();
    }
    placed = await placeWithoutOverwrite(partial, directory, `logo-${id}${extension}`);
    return placed.name;
  } finally {
    if (created && !placed) await fs.rm(partial, { force: true });
  }
};

/**
 * Make an uploaded image the logo, with whatever else of the branding was sent
 * along: both are stored, or neither.
 *
 * @param {{buffer: Buffer, mimetype: string}} file what multer kept of the upload
 * @param {object} [brandingUpdate] the other branding fields, already checked
 * @returns {Promise<{logoUrl: string}>}
 */
const replaceLogo = async ({ buffer, mimetype }, brandingUpdate = {}) => {
  const extension = EXTENSIONS[mimetype];
  if (!extension) throw new Error(`Not a logo type: ${mimetype}`);

  const name = await writeLogoFile(buffer, extension);
  const logoUrl = logoUrlFor(name);

  let change;
  try {
    change = await settingsService.replaceBranding({ ...brandingUpdate, appLogoUrl: logoUrl });
  } catch (error) {
    // Not the logo, and nothing refers to it: the one in use stays.
    await removeLogoFile(name);
    throw error;
  }

  await forgetReplacedLogo(change.previous.appLogoUrl, change.current.appLogoUrl);
  logger.info({ name, size: buffer.length, mimetype }, 'Logo replaced');
  return { logoUrl };
};

module.exports = {
  forgetReplacedLogo,
  ownLogoName,
  replaceLogo,
  sweepUnreferencedLogos,
};
