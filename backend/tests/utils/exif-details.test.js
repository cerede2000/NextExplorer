import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import sharp from 'sharp';

import {
  readExifDetails,
  describeExif,
  toDecimalDegrees,
  withoutTimezone,
  TIFF_READ_MAX_BYTES,
} from '../../src/utils/exifDetails.js';

/**
 * The details a photograph carries, after `exifr` was dropped.
 *
 * It was the last thing in the image that opened somebody else's file with a
 * library nobody had published since 2022. What replaced it reads the block
 * sharp already hands back, so what has to be pinned here is that each format
 * still arrives with its camera, its lens and its coordinates — and that the
 * two formats sharp does *not* hand a block for are still answered.
 */

const EXIF = {
  IFD0: { Make: 'NIKON CORPORATION', Model: 'NIKON Z 6', Software: 'Ver.03.50' },
  IFD2: { DateTimeOriginal: '2024:05:03 18:22:41', LensModel: 'NIKKOR Z 24-70mm f/4 S' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '48/1 51/1 2952/100',
    GPSLongitudeRef: 'E',
    GPSLongitude: '2/1 17/1 2988/100',
  },
};

let dir;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exif-details-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A picture of the requested format, carrying the block above. */
const writePicture = async (name, format) => {
  const file = path.join(dir, name);
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
    .withExif(EXIF)
    .toFormat(format)
    .toFile(file);
  return file;
};

/** Everything sharp can open, read through the block it hands back. */
describe.each([
  ['a JPEG', 'camera.jpg', 'jpeg'],
  ['a PNG', 'camera.png', 'png'],
  ['a WebP', 'camera.webp', 'webp'],
  // AVIF is the HEIF container HEIC also uses, and libvips pulls the block out
  // of it the same way for both. sharp cannot *write* a HEIC — the encoder is
  // patent-encumbered and left out of every prebuilt libvips — so this is how
  // the container is covered at all.
  ['an AVIF, the container HEIC also uses', 'camera.avif', 'avif'],
])('%s', (_label, name, format) => {
  it('arrives with its camera, its lens and where it was taken', async () => {
    const file = await writePicture(name, format);
    const metadata = await sharp(file).metadata();

    const details = await readExifDetails(file, metadata, format);

    expect(details).toMatchObject({
      cameraMake: 'NIKON CORPORATION',
      cameraModel: 'NIKON Z 6',
      lensModel: 'NIKKOR Z 24-70mm f/4 S',
      software: 'Ver.03.50',
      dateTaken: '2024-05-03T18:22:41',
    });
    expect(details.gps.lat).toBeCloseTo(48.8582, 4);
    expect(details.gps.lon).toBeCloseTo(2.29163, 4);
  });
});

/**
 * A minimal, valid baseline TIFF whose directory sits right after the header.
 *
 * Written by hand because sharp cannot put an EXIF block in a TIFF — it drops
 * it silently — and because it is the shape this code has to handle: in a TIFF
 * the file *is* the block, so sharp reports no separate EXIF and the file has
 * to be read.
 */
const makeTiff = ({ make = 'NIKON CORPORATION', model = 'NIKON Z 6' } = {}) => {
  const SHORT = 3;
  const LONG = 4;
  const ASCII = 2;
  const strings = [make, model].map((s) => Buffer.from(`${s}\0`, 'ascii'));
  const entryCount = 11;
  const ifdSize = 2 + entryCount * 12 + 4;
  let dataOffset = 8 + ifdSize;
  const chunks = [];
  const place = (buffer) => {
    const at = dataOffset;
    chunks.push(buffer);
    dataOffset += buffer.length;
    return at;
  };
  const makeAt = place(strings[0]);
  const modelAt = place(strings[1]);
  const pixelAt = place(Buffer.from([0x7f]));

  const entries = [
    [256, SHORT, 1, 1],
    [257, SHORT, 1, 1],
    [258, SHORT, 1, 8],
    [259, SHORT, 1, 1],
    [262, SHORT, 1, 1],
    [271, ASCII, strings[0].length, makeAt],
    [272, ASCII, strings[1].length, modelAt],
    [273, LONG, 1, pixelAt],
    [277, SHORT, 1, 1],
    [278, SHORT, 1, 1],
    [279, LONG, 1, 1],
  ];

  const ifd = Buffer.alloc(ifdSize);
  ifd.writeUInt16LE(entryCount, 0);
  entries.forEach(([tag, type, count, value], index) => {
    const at = 2 + index * 12;
    ifd.writeUInt16LE(tag, at);
    ifd.writeUInt16LE(type, at + 2);
    ifd.writeUInt32LE(count, at + 4);
    if (type === SHORT && count === 1) ifd.writeUInt16LE(value, at + 8);
    else ifd.writeUInt32LE(value, at + 8);
  });

  const header = Buffer.alloc(8);
  header.write('II', 0, 'ascii');
  header.writeUInt16LE(0x2a, 2);
  header.writeUInt32LE(8, 4);
  return Buffer.concat([header, ifd, ...chunks]);
};

describe('a TIFF, where the file is the block', () => {
  it('is read from the file, since sharp hands back no block for one', async () => {
    const file = path.join(dir, 'scan.tif');
    await fs.writeFile(file, makeTiff());
    const metadata = await sharp(file).metadata();

    expect(metadata.exif).toBeUndefined();

    const details = await readExifDetails(file, metadata, 'tif');

    expect(details).toMatchObject({ cameraMake: 'NIKON CORPORATION', cameraModel: 'NIKON Z 6' });
  });

  /**
   * The ceiling, and the proof that it is the ceiling doing the refusing: the
   * same unreadable content under it reaches the parser and is reported as
   * broken, while above it nothing is read at all.
   *
   * The large file is made sparse — truncated, never written — so this costs a
   * stat and no disk.
   */
  it('stops short of reading a scan larger than the ceiling', async () => {
    const small = path.join(dir, 'small.tif');
    await fs.writeFile(small, Buffer.alloc(1024));
    await expect(readExifDetails(small, null, 'tif')).rejects.toThrow();

    const huge = path.join(dir, 'huge.tif');
    const handle = await fs.open(huge, 'w');
    await handle.truncate(TIFF_READ_MAX_BYTES + 1);
    await handle.close();

    await expect(readExifDetails(huge, null, 'tif')).resolves.toBeNull();
  });
});

describe('a file with nothing to say', () => {
  it('has no details rather than empty ones', async () => {
    const file = path.join(dir, 'plain.png');
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
      .png()
      .toFile(file);
    const metadata = await sharp(file).metadata();

    await expect(readExifDetails(file, metadata, 'png')).resolves.toBeNull();
  });

  it('does not go looking in a format that cannot carry a block', async () => {
    const file = path.join(dir, 'absent.gif');

    await expect(readExifDetails(file, { format: 'gif' }, 'gif')).resolves.toBeNull();
  });
});

describe('the dates a camera writes', () => {
  /**
   * EXIF says 18:22:41 and nothing about where. Sent with a zone, a browser an
   * hour away shows an hour the photograph was not taken at; sent without one,
   * it is read as local time wherever it is displayed, which is what the
   * camera showed.
   */
  it('keeps the hour the camera showed, with no zone attached', () => {
    const date = new Date(Date.UTC(2024, 4, 3, 18, 22, 41));

    expect(withoutTimezone(date)).toBe('2024-05-03T18:22:41');
    expect(withoutTimezone(date)).not.toMatch(/Z$/);
  });

  it('pads a single-digit month, day and hour', () => {
    expect(withoutTimezone(new Date(Date.UTC(2024, 0, 2, 3, 4, 5)))).toBe('2024-01-02T03:04:05');
  });

  it('passes through what it cannot read as a date', () => {
    expect(withoutTimezone('0000:00:00 00:00:00')).toBe('0000:00:00 00:00:00');
    expect(withoutTimezone(new Date('nonsense'))).toBeNull();
    expect(withoutTimezone(undefined)).toBeNull();
  });

  it('takes the moment the shutter opened over the one the file was written', () => {
    const described = describeExif({
      Image: { DateTime: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) },
      Photo: {
        DateTimeOriginal: new Date(Date.UTC(2024, 4, 3, 18, 22, 41)),
        DateTimeDigitized: new Date(Date.UTC(2024, 4, 4, 9, 0, 0)),
      },
    });

    expect(described.dateTaken).toBe('2024-05-03T18:22:41');
  });

  it('falls back to the moment it was digitised, then to the file’s own', () => {
    const digitised = describeExif({
      Image: { DateTime: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) },
      Photo: { DateTimeDigitized: new Date(Date.UTC(2024, 4, 4, 9, 0, 0)) },
    });
    expect(digitised.dateTaken).toBe('2024-05-04T09:00:00');

    const written = describeExif({ Image: { DateTime: new Date(Date.UTC(2025, 0, 1, 7, 30, 0)) } });
    expect(written.dateTaken).toBe('2025-01-01T07:30:00');
  });
});

describe('where a photograph was taken', () => {
  it('turns degrees, minutes and seconds into the one number a map needs', () => {
    expect(toDecimalDegrees([48, 51, 29.52], 'N')).toBeCloseTo(48.8582, 6);
  });

  it('reads south and west as the other side of zero', () => {
    expect(toDecimalDegrees([33, 51, 54], 'S')).toBeCloseTo(-33.865, 6);
    expect(toDecimalDegrees([151, 12, 36], 'W')).toBeCloseTo(-151.21, 6);
  });

  /**
   * A negative degree with a southern reference must not cancel out into the
   * northern hemisphere: the sign is the reference's to give, once.
   */
  it('takes the sign from the reference alone', () => {
    expect(toDecimalDegrees([-33, 51, 54], 'S')).toBeCloseTo(-33.865, 6);
    expect(toDecimalDegrees([-33, 51, 54], 'N')).toBeCloseTo(33.865, 6);
  });

  it('accepts degrees alone, and refuses what is not a number', () => {
    expect(toDecimalDegrees([12], 'E')).toBe(12);
    expect(toDecimalDegrees(['north'], 'N')).toBeNull();
    expect(toDecimalDegrees([], 'N')).toBeNull();
    expect(toDecimalDegrees(undefined, 'N')).toBeNull();
  });

  it('says nothing rather than half a position', () => {
    const described = describeExif({
      Image: { Make: 'Canon' },
      GPSInfo: { GPSLatitude: [48, 51, 29.52], GPSLatitudeRef: 'N' },
    });

    expect(described.gps).toBeNull();
    expect(described.cameraMake).toBe('Canon');
  });
});

describe('a block with none of the fields', () => {
  it('answers every field rather than leaving them out', () => {
    expect(describeExif({ Image: {} })).toEqual({
      cameraMake: null,
      cameraModel: null,
      lensModel: null,
      software: null,
      dateTaken: null,
      gps: null,
    });
  });

  it('is nothing at all when there is no block', () => {
    expect(describeExif(null)).toBeNull();
  });
});
