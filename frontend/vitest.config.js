import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config';
import viteConfig from './vite.config.js';

import { warnAboutNodeMajor } from '../scripts/node-major-notice.mjs';

// Once, in the main process: vitest intercepts the console inside a worker,
// so the same notice from a setup file would never be shown.
warnAboutNodeMajor();

// One file holds both sides' floors, so the CI summary can read the same
// numbers the suites are held to rather than a copy that drifts.
const floors = JSON.parse(
  readFileSync(new URL('../coverage-thresholds.json', import.meta.url), 'utf8')
).frontend;

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      /**
       * Long enough that a test dies of its own error rather than of the clock.
       *
       * `tabWarmup > gets it ready` failed at the five-second default, and
       * five seconds is what it said: a timeout, with no cause. Raised, the
       * same run says what actually happened — `getActivePinia()` called with
       * no Pinia mounted, because the spec took the module under test from a
       * static import and mocked its stores afterwards. The timeout was never
       * the fault; it was the lid on it, and two earlier readings of that
       * failure as a slow machine were wrong for the same reason.
       *
       * It hides nothing. The slowest case in this suite is 902 ms and the
       * whole of it runs in about half a minute, so nothing legitimately sits
       * between one second and this ceiling — a case that reaches it has
       * stopped, and what stopped it now gets to say so.
       */
      testTimeout: 20000,
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.js'],
      exclude: [...configDefaults.exclude, 'e2e/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
      coverage: {
        // Held everywhere: jsdom needs nothing installed, so a laptop covers
        // what CI covers and a drop shows up before the push, not after it.
        thresholds: floors,
      },
    },
  })
);
