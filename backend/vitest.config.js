import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// One file holds both sides' floors, so the CI summary can read the same
// numbers the suites are held to rather than a copy that drifts.
const floors = JSON.parse(
  readFileSync(new URL('../coverage-thresholds.json', import.meta.url), 'utf8')
).backend;

export default defineConfig({
  test: {
    // Why this exists: tests/setup/loopback-listen.js
    setupFiles: ['./tests/setup/loopback-listen.js'],
    coverage: {
      // Held in CI only. Several suites skip themselves when 7-Zip, ffmpeg,
      // ripgrep or pdftotext are missing, and CI installs all four; a machine
      // without them covers a couple of points less for no fault of the change
      // being tested. The floor is the CI figure, so it is CI that holds it.
      thresholds: process.env.CI ? floors : undefined,
    },
  },
});
