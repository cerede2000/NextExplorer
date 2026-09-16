import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The rule that a change in behaviour arrives with its test.
 *
 * scripts/check-commit-tests.sh holds it, and it has one exception: a commit
 * that says why it carries no test. The exception used to be read as a git
 * trailer, which only exists when the whole last paragraph looks like one — so
 * a reason long enough to wrap stopped being an exception, silently, and the
 * refusal surfaced on whoever pushed next. These run the guard over commits
 * built for it rather than over the repository's own history.
 */

const guard = path.resolve(__dirname, '..', '..', '..', 'scripts', 'check-commit-tests.sh');

let repo;

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

const commit = (message, files) => {
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.join(repo, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), contents);
  }
  const body = path.join(repo, '.git', 'TEST_COMMIT_BODY');
  fs.writeFileSync(body, message);
  git('add', '-A');
  git('commit', '--no-gpg-sign', '-F', body);
  return git('rev-parse', 'HEAD').trim();
};

// The guard's own exit code is what CI reads, so both halves are kept.
const check = (from) => {
  try {
    const stdout = execFileSync('bash', [guard, `${from}..HEAD`], { cwd: repo, encoding: 'utf8' });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'commit-guard-'));
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'guard@example.test');
  git('config', 'user.name', 'Guard');
  git('config', 'commit.gpgsign', 'false');
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('a commit that changes application code', () => {
  it('passes when it carries a test of its own', () => {
    const base = commit('Start somewhere', { 'README.md': 'start\n' });
    commit('Refuse an empty name', {
      'backend/src/services/naming.js': 'module.exports = () => null;\n',
      'backend/tests/services/naming.test.js': "it('refuses', () => {});\n",
    });

    expect(check(base)).toEqual({ code: 0, output: expect.stringContaining('OK: 1 commit') });
  });

  it('passes when the test is a front-end spec beside it', () => {
    const base = git('rev-parse', 'HEAD').trim();
    commit('Hold the panel still', {
      'frontend/src/components/Panel.vue': '<template><div /></template>\n',
      'frontend/src/components/__tests__/Panel.spec.js': "it('holds', () => {});\n",
    });

    expect(check(base).code).toBe(0);
  });

  it('is refused when it carries none, and says which files', () => {
    const base = git('rev-parse', 'HEAD').trim();
    commit('Change what nobody watches', {
      'backend/src/services/quiet.js': 'module.exports = () => 1;\n',
    });

    const { code, output } = check(base);
    expect(code).toBe(1);
    expect(output).toContain('Change what nobody watches');
    expect(output).toContain('backend/src/services/quiet.js');
    expect(output).toContain('1 commit(s) change application code without a test.');
  });
});

describe('the stated exception', () => {
  it('is taken when the reason fits on one line', () => {
    const base = git('rev-parse', 'HEAD').trim();
    commit(
      ['Move the helper', '', 'No-test: pure move, covered by tests/services/naming.test.js'].join(
        '\n'
      ),
      { 'backend/src/services/moved.js': 'module.exports = () => 2;\n' }
    );

    expect(check(base).code).toBe(0);
  });

  it('is taken when the reason wraps onto a second line', () => {
    const base = git('rev-parse', 'HEAD').trim();
    commit(
      [
        'Swap the library for one that is maintained',
        '',
        'No-test: covered by tests/routes/archive-visibility.test.js, which caught',
        'the constructor change by failing on all three paths before this.',
      ].join('\n'),
      { 'backend/src/services/wrapped.js': 'module.exports = () => 3;\n' }
    );

    expect(check(base)).toEqual({ code: 0, output: expect.stringContaining('OK: 1 commit') });
  });

  it('is not taken when the trailer names no reason', () => {
    const base = git('rev-parse', 'HEAD').trim();
    commit(['Change something quietly', '', 'No-test:'].join('\n'), {
      'backend/src/services/blank.js': 'module.exports = () => 4;\n',
    });

    expect(check(base).code).toBe(1);
  });

  it('is not taken from a sentence that merely mentions it', () => {
    const base = git('rev-parse', 'HEAD').trim();
    commit(
      [
        'Change something else quietly',
        '',
        'A commit like this would normally carry a No-test: line, and this one',
        'deliberately does not.',
      ].join('\n'),
      { 'backend/src/services/mention.js': 'module.exports = () => 5;\n' }
    );

    expect(check(base).code).toBe(1);
  });
});
