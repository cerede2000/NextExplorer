import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearModuleCache, overrideEnv } from '../helpers/env-test-utils.js';

/**
 * Secrets are readable from a file, not only from the environment.
 *
 * A secret passed as an environment variable is printed back by `docker inspect`
 * and kept in the container's stored configuration, which is why orchestrators
 * mount secrets as files instead. Every credential the server takes therefore
 * accepts a companion `_FILE` variable naming the file to read.
 *
 * The failure that makes this worth pinning is quiet: a file written with
 * `echo secret > file` ends in a newline, and a secret carrying an invisible
 * trailing newline signs tokens the Document Server then rejects, with nothing
 * in either log to say why.
 */

const requireFreshConfig = () => {
  clearModuleCache('src/utils/env');
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');
  // eslint-disable-next-line global-require
  return require('../../src/config/index');
};

const requireFreshEnv = () => {
  clearModuleCache('src/utils/env');
  clearModuleCache('src/config/env');
  // eslint-disable-next-line global-require
  return require('../../src/config/env');
};

describe('Secrets from files', () => {
  let dir;
  let restoreEnv;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextexplorer-secret-files-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = null;
    }
  });

  /** Write a secret file and return its path. */
  const secretFile = (name, contents) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return file;
  };

  it('reads a secret from the file the _FILE variable names', () => {
    restoreEnv = overrideEnv({
      ONLYOFFICE_SECRET: undefined,
      ONLYOFFICE_SECRET_FILE: secretFile('onlyoffice', 'from-the-file'),
    });

    expect(requireFreshEnv().ONLYOFFICE_SECRET).toBe('from-the-file');
  });

  it('drops the trailing newline a shell redirection leaves behind', () => {
    // `echo secret > file` is how these files get written, and the newline
    // would otherwise travel into every signature the secret produces.
    restoreEnv = overrideEnv({
      ONLYOFFICE_SECRET: undefined,
      ONLYOFFICE_SECRET_FILE: secretFile('onlyoffice-newline', 'from-the-file\n'),
    });

    expect(requireFreshEnv().ONLYOFFICE_SECRET).toBe('from-the-file');
  });

  it('prefers the variable when both are set', () => {
    restoreEnv = overrideEnv({
      ONLYOFFICE_SECRET: 'from-the-environment',
      ONLYOFFICE_SECRET_FILE: secretFile('onlyoffice-ignored', 'from-the-file'),
    });

    expect(requireFreshEnv().ONLYOFFICE_SECRET).toBe('from-the-environment');
  });

  it('covers every credential the server takes', () => {
    restoreEnv = overrideEnv({
      SESSION_SECRET: undefined,
      AUTH_SESSION_SECRET: undefined,
      AUTH_ADMIN_PASSWORD: undefined,
      ADMIN_PASSWORD: undefined,
      OIDC_CLIENT_SECRET: undefined,
      ONLYOFFICE_SECRET: undefined,
      COLLABORA_SECRET: undefined,
      SESSION_SECRET_FILE: secretFile('session', 'session-value'),
      AUTH_ADMIN_PASSWORD_FILE: secretFile('admin', 'admin-value'),
      OIDC_CLIENT_SECRET_FILE: secretFile('oidc', 'oidc-value'),
      ONLYOFFICE_SECRET_FILE: secretFile('oo', 'onlyoffice-value'),
      COLLABORA_SECRET_FILE: secretFile('collabora', 'collabora-value'),
    });

    const env = requireFreshEnv();
    expect(env.SESSION_SECRET).toBe('session-value');
    expect(env.AUTH_ADMIN_PASSWORD).toBe('admin-value');
    expect(env.OIDC_CLIENT_SECRET).toBe('oidc-value');
    expect(env.ONLYOFFICE_SECRET).toBe('onlyoffice-value');
    expect(env.COLLABORA_SECRET).toBe('collabora-value');
  });

  it('answers on a legacy alias when the current name says nothing', () => {
    restoreEnv = overrideEnv({
      SESSION_SECRET: undefined,
      SESSION_SECRET_FILE: undefined,
      AUTH_SESSION_SECRET: undefined,
      AUTH_SESSION_SECRET_FILE: secretFile('legacy-session', 'legacy-value'),
    });

    expect(requireFreshEnv().SESSION_SECRET).toBe('legacy-value');
  });

  it('refuses to start when the file cannot be read', () => {
    // Resolving to null instead would start the server with document signing
    // silently disabled — the operator named that file for a reason.
    restoreEnv = overrideEnv({
      ONLYOFFICE_SECRET: undefined,
      ONLYOFFICE_SECRET_FILE: path.join(dir, 'does-not-exist'),
    });

    expect(() => requireFreshEnv()).toThrow(/ONLYOFFICE_SECRET_FILE/);
  });

  it('refuses to start when the file is empty', () => {
    restoreEnv = overrideEnv({
      ONLYOFFICE_SECRET: undefined,
      ONLYOFFICE_SECRET_FILE: secretFile('blank', '   \n'),
    });

    expect(() => requireFreshEnv()).toThrow(/empty/);
  });

  it('carries the file-borne secret through to the editor configuration', () => {
    // What the rest of the server actually reads is the resolved config, so the
    // value has to survive the layer above env.js.
    restoreEnv = overrideEnv({
      ONLYOFFICE_SECRET: undefined,
      ONLYOFFICE_URL: 'https://documents.example.com',
      ONLYOFFICE_SECRET_FILE: secretFile('onlyoffice-config', 'signing-key'),
    });

    expect(requireFreshConfig().onlyoffice.secret).toBe('signing-key');
  });
});
