import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:4173' },
  webServer: [
    { command: 'corepack pnpm --filter @pwb/server dev', url: 'http://127.0.0.1:4310/health', reuseExistingServer: true, env: { PWB_STUDIO_ORIGIN: 'http://127.0.0.1:4173' } },
    { command: 'corepack pnpm --filter @pwb/studio preview --host 127.0.0.1', port: 4173, reuseExistingServer: true },
  ],
});
