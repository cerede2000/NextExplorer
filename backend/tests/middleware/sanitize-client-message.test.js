import { describe, it, expect, afterEach } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Error messages reach the browser, and the ones coming from the filesystem
 * carry absolute paths that describe the server's layout. They are reduced to
 * a basename — without eating the sentence around them, which an earlier
 * pattern did whenever a message mentioned two paths.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const load = async () => {
  currentEnv = await setupTestEnv({
    tag: 'sanitize-message-',
    modules: ['src/config/env', 'src/config/index', 'src/middleware/errorHandler'],
  });
  return currentEnv.requireFresh('src/middleware/errorHandler').sanitizeClientMessage;
};

describe('sanitizeClientMessage', () => {
  it('keeps the sentence intact when a message names two paths', async () => {
    const sanitize = await load();

    // The whole point: the words between the two paths must survive.
    expect(sanitize('Failed to copy /srv/data/a.txt to /srv/data/b.txt')).toBe(
      'Failed to copy …/a.txt to …/b.txt'
    );
  });

  it('reduces a path to its basename wherever it appears', async () => {
    const sanitize = await load();

    expect(sanitize('/var/lib/app/report.pdf is locked')).toBe('…/report.pdf is locked');
    expect(sanitize('cannot read (/var/lib/x/y.txt)')).toBe('cannot read (…/y.txt)');
    // A space in the file name itself is fine: the user typed that one.
    expect(sanitize('ENOENT: /srv/data/my file.txt not found')).toBe(
      'ENOENT: …/my file.txt not found'
    );
  });

  it('leaves a message with no path alone', async () => {
    const sanitize = await load();

    expect(sanitize('Permission denied')).toBe('Permission denied');
    expect(sanitize('')).toBe('');
    expect(sanitize(undefined)).toBe(undefined);
  });
});
