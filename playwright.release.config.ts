import { defineConfig, devices } from '@playwright/test';

/**
 * The independent evidence runner for the finalization stage.
 *
 * It is a separate configuration on purpose: the release is measured on three
 * engines against the compiled bundle served under its own headers, while the
 * Fase 0 suite keeps measuring the studio on Chromium. Each spec writes typed
 * artifacts that Gate 3 reads directly, so no summary sits between a
 * measurement and the decision.
 *
 * The harness binds an ephemeral port in `globalSetup` and publishes its origin
 * through `PWB_RELEASE_ORIGIN`, so a run never competes for a fixed port.
 */
/**
 * Every engine runs by default. `PWB_RELEASE_ENGINES` narrows the set on a host
 * where one of them cannot launch — the gate then reports that engine as
 * missing evidence instead of treating its absence as a pass.
 */
const ENGINES = (process.env.PWB_RELEASE_ENGINES ?? 'chromium,firefox,webkit').split(',').map((name) => name.trim()).filter((name) => name !== '');
const ALL = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
];

export default defineConfig({
  testDir: './tests/release',
  globalSetup: './tests/release/global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  projects: ALL.filter((project) => ENGINES.includes(project.name)),
});
