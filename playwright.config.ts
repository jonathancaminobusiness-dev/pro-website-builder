import { defineConfig } from '@playwright/test';

/**
 * Several checkouts of this repo run their suites on one machine, so the harness can take its own
 * port block: set PWB_E2E_PORT_BASE and the API, the isolated preview and the Studio move together,
 * and no run reuses a server another checkout started. Without it the classic developer ports stand.
 */
const portBase = Number(process.env.PWB_E2E_PORT_BASE ?? 0);
const apiPort = portBase > 0 ? portBase : 4310;
const previewPort = portBase > 0 ? portBase + 1 : 4311;
const studioPort = portBase > 0 ? portBase + 2 : 4173;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const previewOrigin = `http://127.0.0.1:${previewPort}`;
const studioOrigin = process.env.PWB_STUDIO_ORIGIN ?? `http://127.0.0.1:${studioPort}`;
const studioEnv = { VITE_API_ORIGIN: apiOrigin, VITE_PREVIEW_ORIGIN: previewOrigin };

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: { browserName: 'chromium', baseURL: studioOrigin },
  webServer: [
    {
      command: 'corepack pnpm --filter @pwb/server dev',
      url: `${apiOrigin}/health`,
      reuseExistingServer: portBase === 0,
      env: { PWB_STUDIO_ORIGIN: studioOrigin, PWB_PORT: String(apiPort), PWB_PREVIEW_PORT: String(previewPort) },
    },
    {
      command: portBase > 0
        ? `corepack pnpm --filter @pwb/studio dev --port ${studioPort} --strictPort`
        : 'corepack pnpm --filter @pwb/studio preview --host 127.0.0.1',
      port: studioPort,
      reuseExistingServer: portBase === 0,
      env: studioEnv,
    },
  ],
});
