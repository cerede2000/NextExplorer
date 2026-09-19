import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { noticeForNodeMajor } from '../../../scripts/node-major-notice.mjs';

/**
 * One Node major, said in fourteen files, and nothing kept them in step.
 *
 * The image is built on it, the standalone archive carries it, the installer
 * refuses anything else, six workflows install it, three package files and
 * `.nvmrc` declare it, and a documentation page tells a reader to go and get
 * it. They all say 24 today — checked by reading them, after somebody asked
 * why, given that this machine runs 25.
 *
 * The number itself is not the point. What matters is that bumping it is one
 * decision rather than eleven: move the range in the root package.json and
 * this test names every file that still disagrees. A major that reached the
 * image but not the archive would be two products with two ABIs, and the
 * native modules — the SQLite driver, the image processor, the terminal — are
 * prebuilt for exactly one.
 *
 * Node 25 was never a candidate, for the record: odd lines never become LTS,
 * and that one reached end of life on 31 March 2026.
 */

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

/** The one place the answer comes from; everything else has to agree with it. */
const declared = readJson('package.json').engines.node;
const MAJOR = declared.match(/>=(\d+)/)[1];

describe('the Node major this is built and shipped on', () => {
  it('is declared as one major and not a range across two', () => {
    // `>=24 <25` and not `>=24`: the native modules are built for one ABI, so
    // "at least" would be a promise this cannot keep.
    expect(declared).toBe(`>=${MAJOR} <${Number(MAJOR) + 1}`);
  });

  it('is the same in every package that declares one', () => {
    for (const manifest of ['package.json', 'backend/package.json', 'frontend/package.json']) {
      expect(readJson(manifest).engines?.node, `${manifest} disagrees`).toBe(declared);
    }
  });

  it('is what a developer’s shell is told to use', () => {
    // `.nvmrc` is what nvm and fnm read when entering the directory. Without
    // it, the suites here run on whatever that machine happens to have, which
    // is not what CI runs and not what ships.
    expect(read('.nvmrc').trim()).toBe(MAJOR);
  });

  it('is the image the container is built from', () => {
    const bases = read('Dockerfile')
      .split('\n')
      .filter((line) => /^FROM\s+\S*node:/.test(line));

    // Asserted as a list rather than a search: a Dockerfile that stopped
    // naming Node at all would pass a check that only looked for the wrong
    // major.
    expect(bases.length).toBeGreaterThan(0);
    for (const line of bases) {
      expect(line, 'a base image on another major').toMatch(new RegExp(`node:${MAJOR}\\.\\d+[.-]`));
    }
  });

  it('is the runtime the standalone archive carries', () => {
    const assemble = read('packaging/assemble.sh');
    const pinned = assemble.match(/NODE_VERSION="\$\{NODE_VERSION:-(\d+)\.[\d.]+\}"/);
    expect(pinned, 'assemble.sh no longer pins a Node version').not.toBeNull();
    expect(pinned[1]).toBe(MAJOR);
  });

  it('is what the installer insists on when the archive brings none', () => {
    const installer = read('packaging/install.sh');
    const required = installer.match(/NODE_MAJOR_REQUIRED=(\d+)/);
    expect(required, 'install.sh no longer checks the major').not.toBeNull();
    expect(required[1]).toBe(MAJOR);
  });

  it('is what every workflow sets up', () => {
    const directory = path.join(ROOT, '.github', 'workflows');
    const mentions = [];

    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith('.yml')) continue;
      const contents = fs.readFileSync(path.join(directory, file), 'utf8');
      for (const [, version] of contents.matchAll(/node-version:\s*'?"?(\d+)[^\s'"]*/g)) {
        mentions.push([`${file} node-version`, version]);
      }
      for (const [, version] of contents.matchAll(/NODE_VERSION:\s*'?"?(\d+)[^\s'"]*/g)) {
        mentions.push([`${file} NODE_VERSION`, version]);
      }
    }

    // Enumerated, then checked: a regular expression that matched nothing
    // would otherwise report every workflow as agreeing.
    expect(mentions.length).toBeGreaterThanOrEqual(6);
    const wrong = mentions.filter(([, version]) => version !== MAJOR);
    expect(wrong).toEqual([]);
  });

  it('is what the documentation tells somebody to install', () => {
    // The standalone page is where a reader is sent to find a Node, and the
    // number in prose is the one they will act on.
    const page = read('docs/installation/standalone.md');
    expect(page).toContain(`Node ${MAJOR}`);
    expect(page).not.toMatch(new RegExp(`Node ${Number(MAJOR) + 1}\\b`));
  });
});

/**
 * And the one thing that cannot be pinned: the machine somebody works on.
 *
 * `.nvmrc` only helps a shell that reads it. This is what tells the person in
 * front of a suite that the result they are looking at came from a different
 * runtime than the one CI and the image use.
 */
describe('the notice when the running Node is not that one', () => {
  it('says nothing when they agree', () => {
    expect(noticeForNodeMajor(`${MAJOR}.21.0`)).toBeNull();
    // A different patch or minor of the same major is the same ABI.
    expect(noticeForNodeMajor(`${MAJOR}.0.1`)).toBeNull();
  });

  it('names both when they do not', () => {
    const notice = noticeForNodeMajor('25.9.0');

    expect(notice).toContain('Node 25');
    expect(notice).toContain(MAJOR);
    // What to do about it, not only that something is wrong.
    expect(notice).toContain('.nvmrc');
  });
});
