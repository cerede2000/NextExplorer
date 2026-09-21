const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A stand-in for ripgrep, so the search's other half can be run.
 *
 * The search route has two content engines. Which one runs is decided at
 * request time by whether `rg` can be spawned, and the two enforce their bounds
 * in different functions — so a machine without ripgrep runs the fallback and
 * never the code that ships in the image, while CI, which installs ripgrep,
 * runs the opposite half. A guard deleted from either one looks harmless on the
 * machine that does not take that path.
 *
 * This makes the choice explicit instead of ambient. The stand-in answers
 * `--version` so the route takes the ripgrep path, and reports no matches, so
 * whatever the test is about is decided by the route rather than by ripgrep.
 * That is the limit of it: it proves what the route does around ripgrep, never
 * what ripgrep itself finds.
 */

const SCRIPT = `#!/bin/sh
case "$1" in
  --version) echo "ripgrep 14.0.0 (test stand-in)"; exit 0 ;;
esac
exit 1
`;

/**
 * Put the stand-in first on PATH for the duration of a test.
 *
 * @returns {() => void} restores PATH and removes the stand-in
 */
const useFakeRipgrep = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-rg-'));
  const binary = path.join(dir, 'rg');
  fs.writeFileSync(binary, SCRIPT, { mode: 0o755 });

  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath || ''}`;

  return () => {
    process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  };
};

/**
 * A stand-in that lists and searches, for the tests about what the route does
 * with what ripgrep finds.
 *
 * The one above finds nothing, which is enough to prove the route took the
 * ripgrep path and useless for what happens to a path ripgrep reports. This
 * one walks the folder it is started in, as ripgrep does: `--files` prints
 * every file under it, and a content search prints a JSON match for the first
 * line holding the term, case-insensitively. It follows no links and applies
 * no globs — so a path the route should have refused is one it reports, and
 * refusing it is left to the route, which is what these tests are about.
 *
 * Every invocation is appended to a log, so a test can say that it ran.
 */
const WALKING_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (process.env.FAKE_RG_LOG) fs.appendFileSync(process.env.FAKE_RG_LOG, JSON.stringify(args) + '\\n');
if (args.includes('--version')) { console.log('ripgrep 14.0.0 (walking stand-in)'); process.exit(0); }
const walk = (dir, rel) => {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out = out.concat(walk(path.join(dir, entry.name), next));
    else if (entry.isFile()) out.push(next);
  }
  return out;
};
const files = walk('.', '');
if (args.includes('--files')) { for (const file of files) console.log(file); process.exit(0); }
const term = String(args[args.indexOf('--') + 1] || '').toLowerCase();
for (const file of files) {
  const lines = fs.readFileSync(file, 'latin1').split('\\n');
  const index = lines.findIndex((line) => line.toLowerCase().includes(term));
  if (index === -1) continue;
  console.log(JSON.stringify({ type: 'match', data: { path: { text: './' + file }, line_number: index + 1, lines: { text: lines[index] + '\\n' } } }));
}
process.exit(0);
`;

/**
 * Put the walking stand-in first on PATH for the duration of a test.
 *
 * @returns {{ restore: () => void, calls: () => string[][] }}
 */
const useWalkingRipgrep = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walking-rg-'));
  const binary = path.join(dir, 'rg');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(binary, WALKING_SCRIPT, { mode: 0o755 });

  const previousPath = process.env.PATH;
  const previousLog = process.env.FAKE_RG_LOG;
  process.env.PATH = `${dir}${path.delimiter}${previousPath || ''}`;
  process.env.FAKE_RG_LOG = log;

  return {
    calls: () => {
      try {
        return fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    restore: () => {
      process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.FAKE_RG_LOG;
      else process.env.FAKE_RG_LOG = previousLog;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** Whether a real ripgrep is installed on this machine. */
const hasRealRipgrep = () => {
  const previousPath = process.env.PATH;
  return (
    (process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .some((entry) => {
        try {
          fs.accessSync(path.join(entry, 'rg'), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }) && Boolean(previousPath)
  );
};

module.exports = { useFakeRipgrep, useWalkingRipgrep, hasRealRipgrep };
