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

  it('is among the majors the installer accepts when the archive brings none', () => {
    // A list here rather than the single number the rest of this file holds,
    // and the difference is deliberate. What ships is one major, because the
    // archive carries one runtime and the image is built on one. What an
    // archive without a runtime will accept from the machine is every major
    // all three native modules have prebuilds for — the image processor takes
    // any, and the other two publish the same set since node-pty 0.14.
    //
    // The two cannot drift apart in the direction that matters: whatever is
    // shipped has to be accepted, or the full archive would install a runtime
    // its own installer refuses.
    const installer = read('packaging/install.sh');
    const supported = installer.match(/NODE_MAJORS_SUPPORTED="([^"]+)"/);
    expect(supported, 'install.sh no longer checks the major').not.toBeNull();

    const majors = supported[1].trim().split(/\s+/);
    expect(majors).toContain(MAJOR);
    // Every one of them is a major somebody could actually be running: a list
    // that names an end-of-life line is an invitation to install it.
    expect(majors).not.toContain('25');
  });

  it('accepts exactly the majors the terminal has prebuilds for', () => {
    // The one native module that decides it. The SQLite driver publishes the
    // same set and the image processor is N-API, so this is the whole of the
    // constraint — and when it moves, this test says the list may move too.
    const prebuilds = path.join(
      ROOT,
      'node_modules/@homebridge/node-pty-prebuilt-multiarch/prebuilds/linux-x64'
    );
    const abis = new Set(
      fs
        .readdirSync(prebuilds)
        .map((name) => name.match(/^node\.abi(\d+)\.node$/)?.[1])
        .filter(Boolean)
    );

    // Node's own registry: 24 is ABI 137, 25 is 141, 26 is 147.
    const ABI_OF = { 24: '137', 25: '141', 26: '147' };
    const accepted = read('packaging/install.sh')
      .match(/NODE_MAJORS_SUPPORTED="([^"]+)"/)[1]
      .trim()
      .split(/\s+/);

    for (const major of accepted) {
      expect(abis, `Node ${major} has no terminal prebuild`).toContain(ABI_OF[major]);
    }
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
    // sentence stating the condition is the one they will act on. Checked
    // against the installer's own list rather than against a number, and
    // only that sentence: elsewhere the page names an unsupported major on
    // purpose, to say why it is unsupported.
    const page = read('docs/installation/standalone.md');
    const accepted = read('packaging/install.sh')
      .match(/NODE_MAJORS_SUPPORTED="([^"]+)"/)[1]
      .trim()
      .split(/\s+/);

    const condition = page.split('\n').find((line) => line.startsWith('One condition'));
    expect(condition, 'the page no longer states the condition').toBeTruthy();

    for (const major of accepted) {
      expect(condition, `the condition leaves out Node ${major}`).toContain(`Node ${major}`);
    }
    // And says nothing there about a major that would be refused.
    const refused = ['20', '22', '25', '27'].filter((major) => !accepted.includes(major));
    for (const major of refused) {
      expect(condition, `the condition offers Node ${major}`).not.toContain(`Node ${major}`);
    }
    // The major that actually ships has to be one of them, or the full
    // archive would carry a runtime its own installer refuses.
    expect(accepted).toContain(MAJOR);
  });

  it('is what the README inside the archive tells somebody to have', () => {
    // The page above is the guide somebody is sent to. This one travels in the
    // archive and is the first thing they read after unpacking it, which is
    // exactly why it drifted: it went on naming one major for a release after
    // the installer had started accepting two. So every major it names is
    // checked, in both directions.
    const readme = read('packaging/README.md');
    const accepted = read('packaging/install.sh')
      .match(/NODE_MAJORS_SUPPORTED="([^"]+)"/)[1]
      .trim()
      .split(/\s+/);

    const named = [...new Set([...readme.matchAll(/\bNode (\d+)\b/g)].map(([, major]) => major))];
    expect(named.length, 'the README names no Node at all').toBeGreaterThan(0);

    for (const major of named) {
      expect(accepted, `the README names Node ${major}, which the installer refuses`).toContain(
        major
      );
    }
    for (const major of accepted) {
      expect(named, `the README leaves out Node ${major}`).toContain(major);
    }
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
