// Playwright für e2e/ (Stoppuhr je Release). Browser aus PLAYWRIGHT_BROWSERS_PATH (Sandbox: /opt/pw-browsers).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
  use: { headless: true, viewport: { width: 1280, height: 900 }, locale: 'de-DE', trace: 'off' },
});
