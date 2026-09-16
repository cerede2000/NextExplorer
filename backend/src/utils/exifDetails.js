const fs = require('fs/promises');
const exifReader = require('exif-reader');

/**
 * What a photograph says about itself.
 *
 * The EXIF block is read by `exif-reader`, which is maintained alongside sharp
 * and does nothing but walk a TIFF-shaped block with a bounds check on every
 * read. It replaced `exifr`, a parser that stopped being published in 2022 and
 * was the one thing in the image that opened somebody else's file with code
 * nobody maintains any more.
 *
 * The block itself does not need a parser: sharp already opens the file to
 * report its dimensions, and hands the raw block back with them. So a JPEG, a
 * PNG, a WebP, an AVIF or a HEIC costs one read of the file, not two — and the
 * container is picked apart by libvips rather than by us.
 */

/**
 * TIFF is the exception: the file *is* the block, so sharp reports no separate
 * EXIF and there is nothing to hand over. The file is read instead, and given
 * to the same parser, which accepts a bare TIFF header.
 *
 * With a ceiling, because this is one file read inside a request: libtiff
 * writes its directory *after* the image data, so the tags of a large scan sit
 * at the far end of it and only reading the whole file reaches them. Above the
 * ceiling the picture keeps its dimensions and loses the camera's name, which
 * is the right way round — a details panel must not read 200 MB to fill six
 * lines.
 */
const TIFF_READ_MAX_BYTES = 32 * 1024 * 1024;

const readTiffBlock = async (absolutePath) => {
  const stats = await fs.stat(absolutePath);
  if (!stats.isFile() || stats.size > TIFF_READ_MAX_BYTES) return null;
  return fs.readFile(absolutePath);
};

/** Where the EXIF block of a file already described by sharp is to be found. */
const readExifBlock = async (absolutePath, metadata, extension) => {
  if (metadata?.exif) return metadata.exif;
  const isTiff = metadata?.format === 'tiff' || extension === 'tif' || extension === 'tiff';
  return isTiff ? readTiffBlock(absolutePath) : null;
};

/**
 * What each detail is called in an EXIF block, in the order to look.
 *
 * Cameras disagree about which date they write, and the block is split into
 * directories — the picture's own (`Image`), the camera's (`Photo`) — so every
 * field is several places rather than one. A table rather than a chain of
 * `||`, which is what it plainly is and what makes adding a camera's spelling
 * a one-line change.
 */
const EXIF_FIELDS = {
  cameraMake: [['Image', 'Make']],
  cameraModel: [['Image', 'Model']],
  lensModel: [['Photo', 'LensModel']],
  software: [['Image', 'Software']],
  dateTaken: [
    ['Photo', 'DateTimeOriginal'],
    ['Photo', 'DateTimeDigitized'],
    ['Image', 'DateTime'],
  ],
};

/**
 * A moment with no timezone in it.
 *
 * EXIF records the wall clock the camera showed and says nothing about where
 * that was, so the parser reads it as UTC — and a browser then shifts it by
 * its own offset and shows an hour the photograph was not taken at. Sent
 * without a zone, it is read back as local time wherever it is displayed,
 * which is the hour written on the camera.
 */
const withoutTimezone = (value) => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return typeof value === 'string' ? value : null;
  }
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
    `T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
  );
};

/** Degrees, minutes and seconds, as the one number a map needs. */
const toDecimalDegrees = (dms, ref) => {
  if (!Array.isArray(dms) || dms.length === 0) return null;
  const [degrees = 0, minutes = 0, seconds = 0] = dms.map(Number);
  if (![degrees, minutes, seconds].every(Number.isFinite)) return null;
  const magnitude = Math.abs(degrees) + Math.abs(minutes) / 60 + Math.abs(seconds) / 3600;
  const southOrWest = ref === 'S' || ref === 'W';
  return southOrWest ? -magnitude : magnitude;
};

/** Where a photograph was taken, when it says so at all. */
const readCoordinates = (gpsInfo) => {
  if (!gpsInfo) return null;
  const lat = toDecimalDegrees(gpsInfo.GPSLatitude, gpsInfo.GPSLatitudeRef);
  const lon = toDecimalDegrees(gpsInfo.GPSLongitude, gpsInfo.GPSLongitudeRef);
  if (lat === null || lon === null) return null;
  return { lat, lon };
};

/** The fields the details panel shows, from a block the parser has read. */
const describeExif = (block) => {
  if (!block || typeof block !== 'object') return null;

  const fields = Object.fromEntries(
    Object.entries(EXIF_FIELDS).map(([name, candidates]) => [
      name,
      candidates.map(([directory, tag]) => block[directory]?.[tag]).find(Boolean) ?? null,
    ])
  );

  return {
    ...fields,
    dateTaken: withoutTimezone(fields.dateTaken),
    gps: readCoordinates(block.GPSInfo),
  };
};

/**
 * Everything the EXIF block of one file says, or nothing.
 *
 * A file that cannot be parsed is not an error here: a damaged header still
 * has a name, a size and a date, and losing the whole answer over it would be
 * the wrong trade.
 */
const readExifDetails = async (absolutePath, metadata, extension) => {
  const block = await readExifBlock(absolutePath, metadata, extension);
  if (!block) return null;
  return describeExif(exifReader(block));
};

module.exports = {
  readExifDetails,
  describeExif,
  toDecimalDegrees,
  withoutTimezone,
  TIFF_READ_MAX_BYTES,
};
