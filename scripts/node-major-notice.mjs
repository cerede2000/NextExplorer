import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Say, once, when the Node running the tests is not the Node that ships.
 *
 * The image, the archive and every workflow are pinned to one major, because
 * the three native modules in this tree are prebuilt for exactly one ABI. A
 * developer's machine is pinned to nothing: `.nvmrc` only helps somebody whose
 * shell reads it, and this repository was worked on for a while from a Node
 * that had reached end of life, with nothing anywhere saying so.
 *
 * A warning and not a refusal. The suites pass on both, and being unable to
 * run them at all until a runtime is installed is a worse morning than being
 * told what is different. What it buys is that a result which disagrees with
 * CI has a first thing to look at.
 */

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const noticeForNodeMajor = (running = process.versions.node) => {
  let declared;
  try {
    declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines?.node;
  } catch {
    return null;
  }

  const wanted = declared?.match(/>=(\d+)/)?.[1];
  const here = String(running).split('.')[0];
  if (!wanted || wanted === here) return null;

  return `Node ${here} is running these tests; this project is built and shipped on ${wanted} (engines: ${declared}). The native modules are prebuilt for one ABI, so a result here can differ from CI. \`nvm use\` or \`fnm use\` reads .nvmrc.`;
};

/**
 * Said once, from wherever this is called.
 *
 * Written to stderr rather than through `console.warn`: vitest intercepts the
 * console inside a worker and attaches what it catches to whichever test was
 * running, so a notice from a setup file is never shown. Called from the
 * config instead, which runs once in the main process.
 */
export const warnAboutNodeMajor = () => {
  const notice = noticeForNodeMajor();
  if (notice) process.stderr.write(`\n${notice}\n\n`);
  return notice;
};
