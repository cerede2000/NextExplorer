import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every operation that streams its progress belongs to the person who asked,
 * not to the tab they asked from.
 *
 * Each of them used to run inside its own request and be aborted by its own
 * socket closing: a copy, a move, a deletion, an archive unpacked or packed,
 * entries taken out of one, something brought back out of the trash. Closing the
 * tab left half a folder at the destination, half a selection deleted, a
 * half-written archive — and said nothing about which half.
 *
 * They are registered now (`services/operationTasks`) and the response is a
 * window onto the operation. What this holds is that *all* of them are, because
 * one left behind is one that still dies with its tab, and nothing about the
 * ones that were converted would say so. Read out of the sources rather than
 * listed, so a new streaming route either goes through the register or fails
 * here.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = path.resolve(here, '../../src');

const sources = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

const routeFiles = () => sources(path.join(backendSrc, 'routes'));
const named = (file) => path.relative(backendSrc, file);
const read = (file) => fs.readFileSync(file, 'utf8');

describe('an operation that streams its progress', () => {
  /**
   * The status is committed by `startNdjsonStream`, and from then on a failure
   * can only be an error event rather than an HTTP status. The only place that
   * may commit it is the one that opens a window onto a registered operation:
   * anywhere else is a route doing the work inside its own request again.
   */
  it('is streamed by the register, and by nothing else', () => {
    const committing = routeFiles()
      .filter((file) => read(file).includes('startNdjsonStream'))
      .map(named);

    expect(
      committing,
      'these routes commit a streaming response themselves; stream a registered operation instead (utils/taskStream)'
    ).toEqual([]);
  });

  it('finds the routes that stream one, or this is reading nothing', () => {
    const streaming = routeFiles().filter((file) => {
      const source = read(file);
      return source.includes('streamAsTask') || source.includes('streamTask(');
    });

    // Transfers, deletion, the two archive routes, the trash, and the addresses
    // an operation is watched and stopped at.
    expect(streaming.map(named).sort()).toEqual([
      'routes/archive.js',
      'routes/files/delete.js',
      'routes/files/transfer.js',
      'routes/tasks.js',
      'routes/trash.js',
      'routes/zip.js',
    ]);
  });

  /**
   * And none of them ends its work when its connection goes away.
   *
   * That listener is exactly what made a transfer belong to its tab. The list is
   * named rather than required to be empty, because one file holds both kinds:
   * `archive.js` serves an entry's bytes as a download beside the extraction,
   * and that one must stop when the reader does.
   */
  it('does not end when the connection that asked for it does', () => {
    const hangingUp = routeFiles()
      .filter((file) => {
        const source = read(file);
        if (!source.includes('streamAsTask') && !source.includes('streamTask(')) return false;
        return /res\.once\('close'|req\.once\('aborted'|res\.on\('close'/.test(source);
      })
      .map(named);

    expect(
      hangingUp,
      'a route that stops its work when the connection closes has its operation back inside its request'
    ).toEqual(['routes/archive.js']);
  });

  /**
   * The two requests that are meant to end with their connection, so the rule
   * above is a rule rather than an accident of what the tree happens to hold.
   *
   * One entry of an archive, read out of it and piped to the browser: nobody is
   * waiting for the rest of a download they walked away from, and 7-Zip would
   * otherwise go on decompressing into a pipe nothing reads. And an open editor
   * waiting to be told that somebody else joined, where the wait *is* the
   * request and there is no work to abandon at all.
   */
  it('still lets a request that is only reading or waiting be abandoned', () => {
    const archive = read(path.join(backendSrc, 'routes', 'archive.js'));
    const closing = archive.slice(archive.indexOf("res.once('close'"));
    expect(closing).toContain('reading.stop()');

    const longPoll = read(path.join(backendSrc, 'routes', 'onlyoffice.js'));
    expect(longPoll).toContain("req.once('close', abort)");
    expect(longPoll).toContain('waitForChange');
  });
});
