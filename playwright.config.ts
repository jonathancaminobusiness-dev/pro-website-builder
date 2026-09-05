import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:4173' },
  webServer: { command: 'pnpm --filter @pwb/studio preview --host 127.0.0.1', port: 4173, reuseExistingServer: true },
});
