import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config';
import viteConfig from './vite.config';

// One file holds both sides' floors, so the CI summary can read the same
// numbers the suites are held to rather than a copy that drifts.
const floors = JSON.parse(
  readFileSync(new URL('../coverage-thresholds.json', import.meta.url), 'utf8')
).frontend;

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
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
