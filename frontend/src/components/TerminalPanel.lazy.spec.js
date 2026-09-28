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

  /**
   * xterm moved with the terminal itself when a terminal became a place: the
   * drawer is now one of two things that show one, the other being the page
   * behind a terminal tab. What matters is unchanged — nothing that a page loads
   * eagerly may reach it — so both doors have to stay on demand.
   */
  it('is where xterm lives, so it travels with whatever shows a terminal', async () => {
    const surface = (await import('./TerminalSurface.vue?raw')).default;

    expect(surface).toMatch(/@xterm\/xterm/);
  });

  it('is reached from the drawer, which is itself loaded on demand', async () => {
    const panel = (await import('./TerminalPanel.vue?raw')).default;

    expect(panel).toMatch(/TerminalSurface/);
    // Not xterm itself any more: the drawer is chrome around a terminal now.
    expect(panel).not.toMatch(/@xterm\/xterm/);
  });

  /**
   * And from the page behind a terminal tab, which the router loads on demand for
   * the same reason: imported plainly there, xterm would be on every page again
   * with nothing to say so.
   */
  it('is reached from the terminal page, which the router loads on demand', async () => {
    const router = (await import('@/router/index.js?raw')).default;

    expect(router).toMatch(/component: \(\) => import\('@\/views\/TerminalView\.vue'\)/);
    expect(router).not.toMatch(/^import TerminalView from/m);
  });
});
