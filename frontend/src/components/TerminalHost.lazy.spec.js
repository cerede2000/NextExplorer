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
});
