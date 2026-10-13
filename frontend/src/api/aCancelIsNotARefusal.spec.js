import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A reader who presses cancel is not told their operation failed.
 *
 * Every long operation runs in the server now, and stopping one is a request of
 * its own: the stream answers with the operation's own refusal, code
 * `OPERATION_CANCELLED`. That reaches the global error handler, which puts a red
 * notice on the screen — for something the reader just asked for. Hanging up
 * used to say nothing at all, so nothing had to be suppressed.
 *
 * So each of these calls says that code is not a refusal to report, and this is
 * the list: one left out is one red notice nobody can explain, and it is never
 * the same one twice. Add a streamed operation, and add it here.
 */

const requestStream = vi.fn(async () => ({}));

vi.mock('./http', () => ({
  requestStream: (...args) => requestStream(...args),
  requestJson: vi.fn(async () => ({})),
  requestRaw: vi.fn(),
  buildUrl: (endpoint) => endpoint,
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
  encodePath: (value) => String(value || ''),
}));

const files = await import('./files.api');
const archive = await import('./archive.api');
const trash = await import('./trash.api');

const ITEM = { path: 'Docs', name: 'report.txt' };

/** Every operation the server runs and the reader may stop. */
const OPERATIONS = [
  ['a copy', () => files.copyItems([ITEM], 'Archive')],
  ['a move', () => files.moveItems([ITEM], 'Archive')],
  ['a deletion', () => files.deleteItemsStream([ITEM])],
  ['an archive unpacked', () => files.extractZip('Docs/backup.zip')],
  ['an archive made', () => files.compressToZip([ITEM], 'Docs', 'bundle')],
  ['entries taken out of an archive', () => archive.extractFromArchive('Docs/backup.zip', ['a'])],
  ['items brought back out of the trash', () => trash.restoreTrashItemsTo(['id'], 'Archive')],
  [
    'entries of a deleted folder brought back',
    () => trash.restoreTrashEntriesTo('id', ['a.txt'], 'Archive'),
  ],
];

beforeEach(() => {
  requestStream.mockReset();
  requestStream.mockResolvedValue({});
});

describe('stopping an operation', () => {
  it.each(OPERATIONS)('is not reported as a refusal: %s', async (_what, call) => {
    await call();

    expect(requestStream).toHaveBeenCalled();
    for (const [, options] of requestStream.mock.calls) {
      expect(options.suppressErrorCodes, _what).toContain('OPERATION_CANCELLED');
    }
  });

  /**
   * And the password an archive wants is still not reported either, which is a
   * separate thing the same field carries: the dialog asks for it, so a banner
   * saying the extraction failed would be answering a question with a refusal.
   */
  it('leaves the codes a caller asks to keep quiet alone', async () => {
    await files.extractZip('Docs/backup.zip', {
      suppressErrorCodes: ['ARCHIVE_PASSWORD_REQUIRED'],
    });

    expect(requestStream.mock.calls[0][1].suppressErrorCodes).toEqual([
      'OPERATION_CANCELLED',
      'ARCHIVE_PASSWORD_REQUIRED',
    ]);
  });
});
