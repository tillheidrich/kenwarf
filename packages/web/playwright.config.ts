import { defineConfig } from '@playwright/test';

// Prüft die Oberfläche gegen den Mock (VITE_KERN_MOCK=1) auf Port 4302.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4302/', locale: 'de-DE', timezoneId: 'Europe/Berlin' },
  webServer: {
    command: 'VITE_KERN_MOCK=1 npx vite build --outDir dist-mock && npx vite preview --port 4302 --strictPort --outDir dist-mock',
    url: 'http://127.0.0.1:4302/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
