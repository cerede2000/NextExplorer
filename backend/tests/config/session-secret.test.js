import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearModuleCache, overrideEnv } from '../helpers/env-test-utils.js';

/**
 * Without SESSION_SECRET, a restart used to sign everyone out.
 *
 * Sessions are kept in CACHE_DIR/sessions.db and survive a restart; the secret
 * their cookies are signed with did not — it was drawn at random at every start,
 * so every cookie stopped verifying. The secrets derived from it (ONLYOFFICE
 * without ONLYOFFICE_SECRET, thumbnail links) changed with it.
 *
 * Each test loads the configuration afresh, the way a start does, against its
 * own CONFIG_DIR. The logger is left in the module cache so the spies on it see
 * what the freshly loaded configuration says.
 */

// eslint-disable-next-line global-require
const logger = require('../../src/utils/logger');

const HEX_SECRET = /^[0-9a-f]{64}$/;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
// Permissions mean nothing to root, and nothing like this to Windows.
const permissionsHold = !isRoot && process.platform !== 'win32';

const loadConfig = () => {
  clearModuleCache('src/utils/env');
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/sessionSecret');
  clearModuleCache('src/config/index');
  // eslint-disable-next-line global-require
  return require('../../src/config/index');
};

describe('Session secret without SESSION_SECRET', () => {
  let tmpRoot;
  let configDir;
  let storedFile;
  let restoreEnv;
  let warn;
  let logged;

  const useEnv = (values = {}) => {
    restoreEnv = overrideEnv({
      CONFIG_DIR: configDir,
      CACHE_DIR: path.join(tmpRoot, 'cache'),
      VOLUME_ROOT: path.join(tmpRoot, 'volume'),
      SESSION_SECRET: undefined,
      SESSION_SECRET_FILE: undefined,
      AUTH_SESSION_SECRET: undefined,
      AUTH_SESSION_SECRET_FILE: undefined,
      ONLYOFFICE_SECRET: undefined,
      ONLYOFFICE_SECRET_FILE: undefined,
      ...values,
    });
  };

  /** Everything the logger was handed, as one string to search. */
  const everythingLogged = () => JSON.stringify(logged);

  const modeOf = (file) => fs.statSync(file).mode & 0o777;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nextexplorer-session-secret-'));
    configDir = path.join(tmpRoot, 'config');
    fs.mkdirSync(configDir);
    storedFile = path.join(configDir, 'session-secret');

    logged = [];
    const record =
      (level) =>
      (...args) => {
        logged.push({ level, args });
      };
    warn = vi.spyOn(logger, 'warn').mockImplementation(record('warn'));
    vi.spyOn(logger, 'info').mockImplementation(record('info'));
    vi.spyOn(logger, 'error').mockImplementation(record('error'));
    vi.spyOn(logger, 'debug').mockImplementation(record('debug'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = null;
    }
    // Hand back permissions a test took away, or the directory cannot go.
    for (const target of [path.dirname(configDir), configDir, storedFile]) {
      try {
        fs.chmodSync(target, 0o700);
      } catch {
        /* never created */
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    clearModuleCache('src/config/index');
  });

  it('stores a generated secret in CONFIG_DIR, readable by the server alone', () => {
    useEnv();

    const { auth } = loadConfig();

    expect(auth.sessionSecret).toMatch(HEX_SECRET);
    expect(fs.readFileSync(storedFile, 'utf8').trim()).toBe(auth.sessionSecret);
    expect(modeOf(storedFile)).toBe(0o600);
    // Written under another name and renamed: nothing of that is left over.
    expect(fs.readdirSync(configDir)).toEqual(['session-secret']);
    expect(everythingLogged()).not.toContain(auth.sessionSecret);
  });

  it('reads the same secret back at the next start', () => {
    useEnv();

    const first = loadConfig().auth.sessionSecret;
    const second = loadConfig().auth.sessionSecret;

    expect(second).toBe(first);
    expect(everythingLogged()).not.toContain(first);
  });

  it('creates CONFIG_DIR when the first start finds none', () => {
    // The configuration is read before bootstrap prepares the directories, so
    // without this the very first start would lose its sessions once.
    configDir = path.join(tmpRoot, 'not-yet', 'config');
    storedFile = path.join(configDir, 'session-secret');
    useEnv();

    const { auth } = loadConfig();

    expect(fs.readFileSync(storedFile, 'utf8').trim()).toBe(auth.sessionSecret);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not inherit the permissions of a staging file an interrupted start left', () => {
    const staging = path.join(configDir, '.session-secret.tmp');
    fs.writeFileSync(staging, 'half-writ', { mode: 0o644 });
    fs.chmodSync(staging, 0o644);
    useEnv();

    const { auth } = loadConfig();

    expect(fs.readFileSync(storedFile, 'utf8').trim()).toBe(auth.sessionSecret);
    expect(modeOf(storedFile)).toBe(0o600);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('keeps the secrets derived from it stable across starts', () => {
    // ONLYOFFICE without ONLYOFFICE_SECRET signs with a derived secret the
    // Document Server has been given; a new one at every start broke it.
    useEnv({ ONLYOFFICE_URL: 'https://documents.example.com' });

    const first = loadConfig();
    const second = loadConfig();

    expect(second.onlyoffice.secret).toBe(first.onlyoffice.secret);
    expect(second.thumbnailAccess.secret).toBe(first.thumbnailAccess.secret);
    // Still derived, never the session secret itself.
    expect(first.onlyoffice.secret).not.toBe(first.auth.sessionSecret);
  });

  it('uses SESSION_SECRET when it is set, and writes nothing', () => {
    useEnv({ SESSION_SECRET: 'configured-in-the-environment' });

    expect(loadConfig().auth.sessionSecret).toBe('configured-in-the-environment');
    expect(fs.existsSync(storedFile)).toBe(false);
  });

  it('uses SESSION_SECRET_FILE when it is set, and writes nothing', () => {
    const secretFile = path.join(tmpRoot, 'mounted-secret');
    fs.writeFileSync(secretFile, 'configured-in-a-file\n');
    useEnv({ SESSION_SECRET_FILE: secretFile });

    expect(loadConfig().auth.sessionSecret).toBe('configured-in-a-file');
    expect(fs.existsSync(storedFile)).toBe(false);
  });

  it('lets a configured secret win over one stored by an earlier start', () => {
    // Setting SESSION_SECRET later must take effect, not be shadowed by the
    // file the unconfigured starts left behind — and must not destroy it.
    const earlier = 'a'.repeat(64);
    fs.writeFileSync(storedFile, `${earlier}\n`, { mode: 0o600 });
    useEnv({ SESSION_SECRET: 'configured-later' });

    expect(loadConfig().auth.sessionSecret).toBe('configured-later');
    expect(fs.readFileSync(storedFile, 'utf8').trim()).toBe(earlier);
  });

  it('falls back to a secret for this run, and says so, when CONFIG_DIR is not a directory', () => {
    // Under a regular file, so the directory cannot exist whoever runs this —
    // root included, which the permission tests below cannot say.
    const blocker = path.join(tmpRoot, 'not-a-directory');
    fs.writeFileSync(blocker, '');
    configDir = path.join(blocker, 'config');
    storedFile = path.join(configDir, 'session-secret');
    useEnv();

    const { auth } = loadConfig();

    expect(auth.sessionSecret).toMatch(HEX_SECRET);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ directory: configDir, code: 'ENOTDIR' }),
      expect.stringMatching(/signed out at the next restart.*SESSION_SECRET/s)
    );
    expect(everythingLogged()).not.toContain(auth.sessionSecret);
  });

  it.skipIf(!permissionsHold)(
    'falls back to a secret for this run, and says so, when CONFIG_DIR cannot be created',
    () => {
      const parent = path.join(tmpRoot, 'locked');
      fs.mkdirSync(parent, { mode: 0o500 });
      fs.chmodSync(parent, 0o500);
      configDir = path.join(parent, 'config');
      storedFile = path.join(configDir, 'session-secret');
      useEnv();

      const { auth } = loadConfig();

      expect(auth.sessionSecret).toMatch(HEX_SECRET);
      expect(fs.existsSync(configDir)).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ directory: configDir, code: 'EACCES' }),
        expect.stringMatching(/signed out at the next restart.*SESSION_SECRET/s)
      );
      expect(everythingLogged()).not.toContain(auth.sessionSecret);
    }
  );

  it.skipIf(!permissionsHold)(
    'falls back to a secret for this run, and says so, when CONFIG_DIR is read-only',
    () => {
      fs.chmodSync(configDir, 0o500);
      useEnv();

      const { auth } = loadConfig();

      expect(auth.sessionSecret).toMatch(HEX_SECRET);
      expect(fs.existsSync(storedFile)).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ directory: configDir, code: 'EACCES' }),
        expect.stringMatching(/signed out at the next restart.*SESSION_SECRET/s)
      );
      expect(everythingLogged()).not.toContain(auth.sessionSecret);
    }
  );

  it('replaces a malformed stored secret, without logging what it held', () => {
    fs.writeFileSync(storedFile, 'hand-written-not-a-secret\n', { mode: 0o644 });
    useEnv();

    const { auth } = loadConfig();

    expect(auth.sessionSecret).toMatch(HEX_SECRET);
    expect(fs.readFileSync(storedFile, 'utf8').trim()).toBe(auth.sessionSecret);
    expect(modeOf(storedFile)).toBe(0o600);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: storedFile }),
      expect.stringMatching(/unusable and is being replaced/)
    );
    expect(everythingLogged()).not.toContain('hand-written-not-a-secret');
    expect(everythingLogged()).not.toContain(auth.sessionSecret);
    // And it is the secret from then on.
    expect(loadConfig().auth.sessionSecret).toBe(auth.sessionSecret);
  });

  it('replaces an empty stored secret', () => {
    // What a start killed between creating the file and writing it would
    // leave, had the file not been renamed into place.
    fs.writeFileSync(storedFile, '');
    useEnv();

    const { auth } = loadConfig();

    expect(auth.sessionSecret).toMatch(HEX_SECRET);
    expect(fs.readFileSync(storedFile, 'utf8').trim()).toBe(auth.sessionSecret);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: storedFile, reason: 'empty' }),
      expect.any(String)
    );
  });

  it.skipIf(!permissionsHold)(
    'leaves a stored secret it cannot read alone, and falls back for this run',
    () => {
      // Owned by another user, say, after a change of PUID with no chown. It
      // may be good again once the permissions are; overwriting it would not.
      const stored = 'b'.repeat(64);
      fs.writeFileSync(storedFile, `${stored}\n`, { mode: 0o600 });
      fs.chmodSync(storedFile, 0o000);
      useEnv();

      const { auth } = loadConfig();

      expect(auth.sessionSecret).toMatch(HEX_SECRET);
      expect(auth.sessionSecret).not.toBe(stored);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ directory: configDir, code: 'EACCES' }),
        expect.stringMatching(/signed out at the next restart/)
      );
      fs.chmodSync(storedFile, 0o600);
      expect(fs.readFileSync(storedFile, 'utf8').trim()).toBe(stored);
    }
  );
});
