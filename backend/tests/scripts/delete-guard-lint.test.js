import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No new way of deleting someone's files around the trash.
 *
 * Deleting goes through the trash; the few files that remove things from disk
 * directly remove what the application created itself, or implement the
 * permanent deletion the trash hands back to. A rule in the lint
 * configuration keeps it that way, and a rule nobody has seen fire is a rule
 * nobody knows works — so this makes it fire.
 */

const { ESLint } = require('eslint');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const eslint = new ESLint({ cwd: repoRoot });

const lint = async (relativeFile, code) => {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, relativeFile) });
  return result.messages
    .filter((message) =>
      ['no-restricted-properties', 'no-restricted-syntax'].includes(message.ruleId)
    )
    .map((message) => message.message);
};

// ESLint puts the restricted name in front of the message for one of the two
// rules, so the reason is what is matched, not the whole line.
const GUARD = expect.stringContaining(
  'Deleting from disk goes through services/trash (see .eslintrc.cjs).'
);

describe('removing from disk outside the trash', () => {
  it('is refused in a new route', async () => {
    const messages = await lint(
      'backend/src/routes/someNewRoute.js',
      "const fs = require('fs/promises');\nmodule.exports = (p) => fs.rm(p, { recursive: true });\n"
    );

    expect(messages).toEqual([GUARD]);
  });

  it('is refused whatever the module is called', async () => {
    const messages = await lint(
      'backend/src/services/someService.js',
      [
        "const fsp = require('fs/promises');",
        "const fsSync = require('fs');",
        'module.exports = async (p) => { await fsp.unlink(p); fsSync.rmdirSync(p); };',
        '',
      ].join('\n')
    );

    expect(messages).toEqual([GUARD, GUARD]);
  });

  it('is refused when the function is taken out of the module', async () => {
    const messages = await lint(
      'backend/src/services/someService.js',
      "const { rm } = require('fs/promises');\nmodule.exports = (p) => rm(p);\n"
    );

    expect(messages).toEqual([GUARD]);
  });

  it('is refused through the rm command', async () => {
    const messages = await lint(
      'backend/src/services/someService.js',
      "const { spawn } = require('child_process');\nmodule.exports = (p) => spawn('rm', ['-rf', p]);\n"
    );

    expect(messages).toEqual([GUARD]);
  });

  it('is allowed in the trash itself', async () => {
    const messages = await lint(
      'backend/src/services/trash/operations.js',
      "const fsp = require('fs/promises');\nmodule.exports = (p) => fsp.rm(p);\n"
    );

    expect(messages).toEqual([]);
  });

  it('is allowed where the application removes what it created', async () => {
    const messages = await lint(
      'backend/src/services/uploadRemnants.js',
      "const fs = require('fs/promises');\nmodule.exports = (p) => fs.unlink(p);\n"
    );

    expect(messages).toEqual([]);
  });

  it('leaves other file operations alone', async () => {
    const messages = await lint(
      'backend/src/routes/someNewRoute.js',
      "const fs = require('fs/promises');\nmodule.exports = (a, b) => fs.rename(a, b);\n"
    );

    expect(messages).toEqual([]);
  });
});
