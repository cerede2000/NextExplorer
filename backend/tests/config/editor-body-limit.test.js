import { describe, it, expect, afterEach } from 'vitest';
import { clearModuleCache, overrideEnv } from '../helpers/env-test-utils.js';

/**
 * The editor sends a file back through a JSON body when it saves. A body limit
 * under the size the editor opens therefore makes a file that opens and cannot
 * be saved — answered with "request entity too large", which names neither of
 * the two settings involved.
 *
 * These are the guarantee that the pair cannot be left in that state, and that
 * it is always the editor that gives way where someone has set a body ceiling
 * on purpose.
 */
const requireFreshConfig = () => {
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');
  // eslint-disable-next-line global-require
  return require('../../src/config/index');
};

const MB = 1024 * 1024;

describe('the body limit and what the editor opens', () => {
  let restoreEnv;

  afterEach(() => {
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = null;
    }
  });

  it('leaves both defaults alone — they already clear each other', () => {
    restoreEnv = overrideEnv({ EDITOR_MAX_FILESIZE: undefined, MAX_JSON_BODY_SIZE: undefined });

    const config = requireFreshConfig();

    expect(config.editor.maxFileSizeBytes).toBe(2 * MB);
    expect(config.uploads.maxJsonBodyBytes).toBe(8 * MB);
  });

  // The configuration our own FAQ recommends for editing large documents.
  it('raises the body limit when the editor is told to open more', () => {
    restoreEnv = overrideEnv({ EDITOR_MAX_FILESIZE: '10M', MAX_JSON_BODY_SIZE: undefined });

    const config = requireFreshConfig();

    expect(config.editor.maxFileSizeBytes).toBe(10 * MB);
    expect(config.uploads.maxJsonBodyBytes).toBeGreaterThan(2 * config.editor.maxFileSizeBytes);
  });

  // Escaping can double the text, and the path travels in the same body.
  it('keeps room for a file that escapes badly', () => {
    restoreEnv = overrideEnv({ EDITOR_MAX_FILESIZE: '4M', MAX_JSON_BODY_SIZE: undefined });

    const config = requireFreshConfig();

    const worstCase = JSON.stringify({
      path: 'Documents/notes.md',
      content: '"\n'.repeat((4 * MB) / 2),
    });
    expect(Buffer.byteLength(worstCase, 'utf-8')).toBeLessThanOrEqual(
      config.uploads.maxJsonBodyBytes
    );
  });

  // A ceiling someone set is a guard, not a detail to be talked out of. The
  // editor is what gives way — by refusing to open what it could not save.
  it('honours a body ceiling that was chosen, and lowers the editor to fit', () => {
    restoreEnv = overrideEnv({ EDITOR_MAX_FILESIZE: '2M', MAX_JSON_BODY_SIZE: '1M' });

    const config = requireFreshConfig();

    expect(config.uploads.maxJsonBodyBytes).toBe(1 * MB);
    expect(config.editor.maxFileSizeBytes).toBeLessThan(1 * MB);
    // Whatever it opens, it can send back.
    expect(config.editor.maxFileSizeBytes * 2).toBeLessThanOrEqual(config.uploads.maxJsonBodyBytes);
  });

  // A body limit raised for its original reason — thousands of paths in one
  // delete — is not pulled back down to the editor's floor.
  it('keeps a larger limit that was asked for', () => {
    restoreEnv = overrideEnv({ EDITOR_MAX_FILESIZE: '2M', MAX_JSON_BODY_SIZE: '64M' });

    const config = requireFreshConfig();

    expect(config.uploads.maxJsonBodyBytes).toBe(64 * MB);
  });
});
