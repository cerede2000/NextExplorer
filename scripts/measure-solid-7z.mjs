#!/usr/bin/env node
/**
 * What a solid `.7z` costs to read, entry by entry.
 *
 * A solid archive compresses every file into one continuous stream, which is
 * what makes it smaller than a zip and what makes reading the last file mean
 * decompressing the ones before it. The panel reads entries one at a time, so
 * the question is whether that cost is worth answering with a cache — and a
 * cache here means keeping the whole extracted tree on disk, which is a real
 * price to pay for somebody who clicked on one file.
 *
 * This measures rather than guesses. Needs a real 7-Zip, so it runs where one
 * exists: `.github/workflows/measure-solid-7z.yml`, on demand.
 *
 *   node scripts/measure-solid-7z.mjs [--files 200] [--kb 256]
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

const argument = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};

const FILES = argument('files', 200);
const KB = argument('kb', 256);

// An empty flag reads as NaN, which built an archive with nothing in it and
// measured that instead. A measurement that cannot say what it measured is
// worse than no measurement.
for (const [name, value] of [
  ['files', FILES],
  ['kb', KB],
]) {
  if (!Number.isFinite(value) || value < 1) {
    console.error(
      `--${name} needs a number of at least 1, and was given ${JSON.stringify(value)}.`
    );
    process.exit(2);
  }
}

/**
 * Content that compresses the way a backup's does — about two to one — rather
 * than the way one repeated line does.
 *
 * The first run of this measured a repeated sentence: fifty megabytes became an
 * eleven-kilobyte archive, so every read was a decompression of almost nothing
 * and the numbers said a solid archive costs nothing to read. What is wanted is
 * the opposite end: bytes that have to be worked for. Half of each file is
 * pseudo-random and incompressible, half is text, from a seeded generator so
 * two runs measure the same thing.
 */
const filler = (seed, kilobytes) => {
  const bytes = Buffer.alloc(kilobytes * 1024);
  let state = (seed + 1) * 2654435761;
  const next = () => {
    // xorshift32: no dependency, same sequence every run.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  const line = Buffer.from(
    `entry ${seed} — the quick brown fox jumps over the lazy dog, again and again. `
  );
  for (let at = 0; at < bytes.length; at += 1) {
    // Alternating kilobyte: one of noise, one of prose.
    bytes[at] = Math.floor(at / 1024) % 2 === 0 ? next() & 0xff : line[at % line.length];
  }
  return bytes;
};

const seconds = (nanoseconds) => Number(nanoseconds / 1000000n) / 1000;

const timed = async (task) => {
  const started = process.hrtime.bigint();
  const value = await task();
  return { value, took: seconds(process.hrtime.bigint() - started) };
};

const sevenZip = async (args, options = {}) =>
  run('7z', args, { maxBuffer: 512 * 1024 * 1024, ...options });

const main = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'solid-7z-'));
  const source = path.join(root, 'source');
  await mkdir(source, { recursive: true });

  const names = [];
  for (let index = 0; index < FILES; index += 1) {
    const name = `file-${String(index).padStart(4, '0')}.txt`;
    names.push(name);
    await writeFile(path.join(source, name), filler(index, KB));
  }

  const archive = path.join(root, 'solid.7z');
  // -ms=on is the default for .7z; named here because it is the whole subject.
  const { took: packing } = await timed(() =>
    sevenZip(['a', '-y', '-ms=on', archive, '.'], { cwd: source })
  );
  const { size } = await stat(archive);
  const uncompressed = FILES * KB * 1024;

  const readEntry = (name) =>
    timed(() => sevenZip(['x', '-so', '-y', '-spd', '--', archive, name]));

  const first = await readEntry(names[0]);
  const middle = await readEntry(names[Math.floor(FILES / 2)]);
  const last = await readEntry(names[FILES - 1]);

  // Ten entries spread through the archive, the way somebody opening a few
  // files from a backup would hit it.
  const spread = Array.from(
    { length: 10 },
    (_, step) => names[Math.floor((step * (FILES - 1)) / 9)]
  );
  const oneByOne = await timed(async () => {
    for (const name of spread) await sevenZip(['x', '-so', '-y', '-spd', '--', archive, name]);
  });

  const destination = path.join(root, 'all');
  const whole = await timed(() => sevenZip(['x', '-y', `-o${destination}`, '--', archive]));

  console.log(
    JSON.stringify(
      {
        files: FILES,
        kilobytesEach: KB,
        uncompressedBytes: uncompressed,
        archiveBytes: size,
        ratio: Number((size / uncompressed).toFixed(3)),
        packingSeconds: packing,
        readFirstSeconds: first.took,
        readMiddleSeconds: middle.took,
        readLastSeconds: last.took,
        tenSpreadEntriesSeconds: oneByOne.took,
        extractWholeSeconds: whole.took,
        // What a cache would have to hold to answer the same reads from disk.
        cacheWouldHoldBytes: uncompressed,
      },
      null,
      2
    )
  );

  await rm(root, { recursive: true, force: true });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
