import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * What the minimal archive takes out of `node_modules`.
 *
 * That archive exists so a distribution can supply its own ExifTool, named by
 * `EXIFTOOL_PATH`. It only works while the package that spawns the program
 * stays: `exiftool-vendored` is the driver, `exiftool-vendored.pl` is the 21 MB
 * of Perl. A pattern that takes both leaves the variable naming a program
 * nothing can run — and it fails silently, because the driver is loaded in a
 * try/catch and a missing one simply means no RAW metadata.
 *
 * So the removal is run rather than restated: the test reads the line out of
 * `assemble.sh` and executes it against a stand-in tree.
 */

const PACKAGING = path.join(__dirname, '..', '..', '..', 'packaging');
const RAW_PREVIEW = path.join(__dirname, '..', '..', 'src', 'services', 'rawPreviewService.js');

/** The one line in assemble.sh that empties the bundled ExifTool out. */
const removalLine = () => {
  const script = fs.readFileSync(path.join(PACKAGING, 'assemble.sh'), 'utf8');
  const line = script
    .split('\n')
    .map((each) => each.trim())
    .find((each) => each.startsWith('rm -rf') && each.includes('exiftool-vendored'));
  if (!line) throw new Error('assemble.sh no longer takes the bundled ExifTool out');
  return line;
};

let sandbox = null;

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  sandbox = null;
});

/**
 * The three packages npm can put there — the driver, the Perl program, the
 * Windows build — and one bystander, run through the script's own line.
 *
 * @returns {string[]} what is left, sorted
 */
const whatSurvives = () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-archive-'));
  const modules = path.join(sandbox, 'app', 'node_modules');
  for (const name of [
    'exiftool-vendored',
    'exiftool-vendored.pl',
    'exiftool-vendored.exe',
    'batch-cluster',
  ]) {
    fs.mkdirSync(path.join(modules, name), { recursive: true });
    fs.writeFileSync(path.join(modules, name, 'package.json'), `{"name":"${name}"}\n`);
  }

  execFileSync('sh', ['-c', `stage="$1"; ${removalLine()}`, 'sh', sandbox]);
  return fs.readdirSync(modules).sort();
};

describe('the minimal archive and the bundled ExifTool', () => {
  it('keeps the package that spawns ExifTool', () => {
    expect(whatSurvives()).toContain('exiftool-vendored');
  });

  it('takes away the Perl program and the Windows build', () => {
    const left = whatSurvives();
    expect(left).not.toContain('exiftool-vendored.pl');
    expect(left).not.toContain('exiftool-vendored.exe');
  });

  it('leaves alone what it was not asked to remove', () => {
    expect(whatSurvives()).toContain('batch-cluster');
  });

  // The contract, rather than the pattern: whatever the service loads is what
  // has to survive. If the require ever changes name, this moves with it.
  it('leaves the module the application loads', () => {
    const service = fs.readFileSync(RAW_PREVIEW, 'utf8');
    const required = service.match(/require\('(exiftool-vendored[^']*)'\)/)?.[1];
    expect(required).toBeTruthy();
    expect(whatSurvives()).toContain(required);
  });
});
