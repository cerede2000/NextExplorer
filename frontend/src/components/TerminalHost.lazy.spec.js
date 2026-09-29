import { describe, expect, it } from 'vitest';

/**
 * The terminal is loaded when the first one is asked for, rather than by every
 * page, because it carries xterm with it — 289 kB for something most sessions
 * never open and only an administrator can.
 *
 * Asked of the source, not by importing the host: importing it under jsdom pulls
 * xterm in, which reaches for a canvas that is not there, and the test hangs. The
 * host itself was checked in a browser, where it opens and runs a shell; what
 * this guards is the pair of lines that are easy to undo — someone turning the
 * lazy import back into a plain one while tidying the layout, or dropping the
 * condition that keeps the host off the page until there is a terminal in it.
 */

describe('the terminal', () => {
  it('is loaded on demand by the layout, not imported into it', async () => {
    const layout = (await import('@/layouts/BrowserLayout.vue?raw')).default;

    expect(layout).toMatch(/defineAsyncComponent\(\s*\(\)\s*=>\s*import\(/);
    expect(layout).not.toMatch(/^import TerminalHost from/m);
  });

  /**
   * And not drawn at all until there is one to draw. An async component loads
   * its chunk when it is first rendered, so a host rendered on every page for
   * every administrator would be xterm on every page for every administrator —
   * which is the cost this was meant to avoid.
   */
  it('is not on the page until a terminal is open', async () => {
    const layout = (await import('@/layouts/BrowserLayout.vue?raw')).default;

    expect(layout).toMatch(/<TerminalHost\s+v-if="[^"]*terminalStore\.openIds\.length > 0"/);
  });

  it('is where xterm lives, so it travels with whatever shows a terminal', async () => {
    const surface = (await import('./TerminalSurface.vue?raw')).default;

    expect(surface).toMatch(/@xterm\/xterm/);
  });

  it('is reached from the host, which is chrome around a terminal rather than one', async () => {
    const host = (await import('./TerminalHost.vue?raw')).default;

    expect(host).toMatch(/TerminalSurface/);
    expect(host).not.toMatch(/@xterm\/xterm/);
  });

  /**
   * The page behind a terminal tab draws no terminal at all — the host draws
   * that one too, which is how a shell survives its tab going behind another —
   * so the router has nothing heavy to load and says so.
   */
  it('is not reached from the terminal page, which only claims a session', async () => {
    const view = (await import('@/views/TerminalView.vue?raw')).default;

    expect(view).not.toMatch(/TerminalSurface/);
    expect(view).toMatch(/useTerminalStore/);
  });

  /**
   * And the terminal's address is inside the layout the host is mounted in.
   *
   * This is the other half of the page drawing nothing, and the two together were
   * a black rectangle: the route sat outside `BrowserLayout` — deliberately, as a
   * document's does — so there was no host on it, and a page whose whole job is to
   * say "my tab wants a terminal" had nobody to say it to. Nothing else could have
   * caught it. Every piece was right on its own, and the chain from the page to
   * the host to the layout was only joined by the route table.
   *
   * Asked of the source, like the rest of this file: importing the router pulls in
   * every screen it names eagerly, which under jsdom reaches for a canvas that is
   * not there and hangs.
   */
  it('is in the layout the terminal address is reached through', async () => {
    const router = (await import('@/router/index.js?raw')).default;
    const between = router.slice(
      router.indexOf("path: '/terminal/"),
      router.indexOf("import('@/views/TerminalView.vue')")
    );

    expect(between).toMatch(/component: BrowserLayout/);
  });
});
