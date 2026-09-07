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
 *
 * All three engines always run. A browser that cannot launch on a given host
 * leaves no artifact, and the gate reports the gap as missing evidence the
 * captain has to accept in writing — never as a pass, and never as a narrower
 * run that looks complete.
 */
const ENGINES = [
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
  projects: ENGINES,
});
