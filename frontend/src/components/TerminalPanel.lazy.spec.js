import { describe, expect, it } from 'vitest';

/**
 * The terminal is loaded when it is first shown rather than by every page,
 * because it carries xterm with it — 289 kB for a panel most sessions never
 * open and only an administrator can.
 *
 * Asked of the source, not by importing the panel: importing it under jsdom
 * pulls xterm in, which reaches for a canvas that is not there, and the test
 * hangs. The panel itself was checked in a browser, where it opens and runs a
 * shell; what this guards is the one line that is easy to undo — someone
 * turning the lazy import back into a plain one while tidying the layout, and
 * putting xterm back on every page with nothing to say so.
 */

describe('the terminal panel', () => {
  it('is loaded on demand by the layout, not imported into it', async () => {
    const layout = (await import('@/layouts/BrowserLayout.vue?raw')).default;

    expect(layout).toMatch(/defineAsyncComponent\(\s*\(\)\s*=>\s*import\(/);
    expect(layout).not.toMatch(/^import TerminalPanel from/m);
  });

  it('is where xterm lives, so it travels with the panel', async () => {
    const panel = (await import('./TerminalPanel.vue?raw')).default;

    expect(panel).toMatch(/@xterm\/xterm/);
  });
});
