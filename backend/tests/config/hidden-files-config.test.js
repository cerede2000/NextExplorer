import { describe, it, expect, afterEach } from 'vitest';
import { clearModuleCache, overrideEnv } from '../helpers/env-test-utils.js';

const requireFreshConfig = () => {
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');

  return require('../../src/config/index');
};

describe('Hidden files config', () => {
  let restoreEnv;

  afterEach(() => {
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = null;
    }
  });

  it('hides dot-prefixed files by default', () => {
    restoreEnv = overrideEnv({
      HIDDEN_FILE_PATTERNS: undefined,
    });

    const config = requireFreshConfig();
    // The dot, and the two suffixes the application's own in-flight files
    // carry: a download being fetched and an upload being written. They are
    // hidden for the same reason a dot-file is — nobody put them there and
    // nobody should open them — and they disappear when the operation ends.
    expect(config.hiddenFiles.patterns).toEqual(['.', 'regex:\\.download$', 'regex:\\.uploading$']);
    expect(config.hiddenFiles.isHiddenName('.env')).toBe(true);
    expect(config.hiddenFiles.isHiddenName('holiday.mp4.download')).toBe(true);
    expect(config.hiddenFiles.isHiddenName('visible.txt')).toBe(false);
  });

  it('supports additional prefix patterns', () => {
    restoreEnv = overrideEnv({
      HIDDEN_FILE_PATTERNS: '.,@',
    });

    const config = requireFreshConfig();
    expect(config.hiddenFiles.isHiddenName('.env')).toBe(true);
    expect(config.hiddenFiles.isHiddenName('@eaDir')).toBe(true);
    expect(config.hiddenFiles.isHiddenName('photos')).toBe(false);
    expect(config.hiddenFiles.ripgrepGlobExcludes).toEqual(['!.*', '!@*']);
  });

  it('supports advanced regex patterns', () => {
    restoreEnv = overrideEnv({
      HIDDEN_FILE_PATTERNS: '.,regex:^#recycle$',
    });

    const config = requireFreshConfig();
    expect(config.hiddenFiles.isHiddenName('#recycle')).toBe(true);
    expect(config.hiddenFiles.isHiddenName('#archive')).toBe(false);
  });

  it('can disable hidden file patterns with an empty value', () => {
    restoreEnv = overrideEnv({
      HIDDEN_FILE_PATTERNS: '',
    });

    const config = requireFreshConfig();
    expect(config.hiddenFiles.patterns).toEqual([]);
    expect(config.hiddenFiles.isHiddenName('.env')).toBe(false);
  });
});
