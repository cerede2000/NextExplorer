/* eslint-env node */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/e2e/media-preview.html',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 7'],
        hasTouch: true,
      },
    },
    // A desktop window is short in proportion to its width, which is where a
    // 16:9 film is the shape that overflows. The phone viewport is tall enough
    // that the same film fits, so a layout test running only there proves
    // nothing about the browser most people use.
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
