import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What an operation writes, recorded until it is done.
 *
 * A stop in the middle of a save, an extraction or a compression left its
 * temporary file, staging folder, half-filled folder or half-written zip in the
 * volume for good. Each operation now records the path before creating it and
 * releases the record however it ends; the next start removes what a record
 * left by an earlier run names — and nothing else.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const setup = async () => {
  envContext = await setupTestEnv({ tag: 'in-flight-' });
  const inFlight = envContext.requireFresh('src/services/inFlightFiles');
  const journal = path.join(envContext.cacheDir, 'in-flight');
  return { inFlight, journal, volume: envContext.volumeDir };
};

const records = (journal) =>
  fs.existsSync(journal) ? fs.readdirSync(journal).filter((n) => n.endsWith('.json')) : [];

/** A record as an earlier run of the server would have left it. */
const leftByEarlierRun = (journal, target, kind = 'temporary-file') => {
  fs.mkdirSync(journal, { recursive: true });
  const file = path.join(journal, `${kind}-${path.basename(target)}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      path: target,
      kind,
      runId: 'an-earlier-run',
      startedAt: '2026-09-01T00:00:00Z',
    })
  );
  return file;
};

describe('an operation in flight', () => {
  it('is recorded until it is released, and releasing twice is harmless', async () => {
    const { inFlight, journal, volume } = await setup();

    const operation = inFlight.track(path.join(volume, '.report.docx.tmp'), 'temporary-file');
    expect(records(journal)).toHaveLength(1);

    operation.release();
    operation.release();
    expect(records(journal)).toHaveLength(0);
  });

  it('of this run is left alone by a sweep, with what it is writing', async () => {
    const { inFlight, journal, volume } = await setup();
    const temporary = path.join(volume, '.report.docx.tmp');
    fs.writeFileSync(temporary, 'half');
    inFlight.track(temporary, 'temporary-file');

    inFlight.sweepInterrupted();

    expect(fs.existsSync(temporary)).toBe(true);
    expect(records(journal)).toHaveLength(1);
  });
});

describe('the sweep at start', () => {
  it('removes what an interrupted operation of an earlier run was writing, and its record', async () => {
    const { inFlight, journal, volume } = await setup();
    const temporary = path.join(volume, 'Docs', '.report.docx.nextexplorer-save-1.tmp');
    const staging = path.join(volume, 'Docs', '.nextexplorer-extract-abc123');
    const partialZip = path.join(volume, 'Docs', 'Archive.zip');
    fs.mkdirSync(path.join(staging, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'nested', 'a.txt'), 'extracted');
    fs.writeFileSync(temporary, 'half a save');
    fs.writeFileSync(partialZip, 'PK half an archive');
    fs.writeFileSync(path.join(volume, 'Docs', 'report.docx'), 'the real file');
    leftByEarlierRun(journal, temporary);
    leftByEarlierRun(journal, staging, 'staging-directory');
    leftByEarlierRun(journal, partialZip, 'partial-archive');

    const { removed } = inFlight.sweepInterrupted();

    expect(removed).toBe(3);
    expect(fs.existsSync(temporary)).toBe(false);
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(partialZip)).toBe(false);
    expect(fs.readFileSync(path.join(volume, 'Docs', 'report.docx'), 'utf8')).toBe('the real file');
    expect(records(journal)).toHaveLength(0);
  });

  it('removes a link it was writing, and not what the link points at', async () => {
    const { inFlight, journal, volume } = await setup();
    const target = path.join(envContext.tmpRoot, 'outside.txt');
    fs.writeFileSync(target, 'not the server’s to remove');
    const link = path.join(volume, '.link.tmp');
    fs.symlinkSync(target, link);
    leftByEarlierRun(journal, link);

    inFlight.sweepInterrupted();

    expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(target, 'utf8')).toBe('not the server’s to remove');
  });

  it('never takes down a configured root, whatever a record says', async () => {
    const { inFlight, journal, volume } = await setup();
    fs.writeFileSync(path.join(volume, 'keep.txt'), 'kept');
    leftByEarlierRun(journal, volume, 'partial-folder');
    leftByEarlierRun(journal, envContext.configDir, 'partial-folder');

    const { removed } = inFlight.sweepInterrupted();

    expect(removed).toBe(0);
    expect(fs.readFileSync(path.join(volume, 'keep.txt'), 'utf8')).toBe('kept');
    expect(records(journal)).toHaveLength(0);
  });

  it('drops a record it cannot read, and one whose path is already gone, without failing', async () => {
    const { inFlight, journal, volume } = await setup();
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(journal, 'cut-short.json'), '{"path": "/vol');
    leftByEarlierRun(journal, path.join(volume, 'gone.tmp'));

    expect(() => inFlight.sweepInterrupted()).not.toThrow();
    expect(records(journal)).toHaveLength(0);
  });
});
