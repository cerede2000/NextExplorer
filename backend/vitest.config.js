import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Why this exists: tests/setup/loopback-listen.js
    setupFiles: ['./tests/setup/loopback-listen.js'],
  },
});
