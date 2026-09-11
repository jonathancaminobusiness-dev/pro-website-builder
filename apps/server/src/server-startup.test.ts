import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from './index.js';
import { modelProviderName } from './provider.js';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const pending = cleanup;
  cleanup = [];
  for (const close of pending) await close();
});

/**
 * The captain's report — three console errors and nothing listening on the API
 * port — has the same shape whatever stopped the process, so the one thing a
 * test can settle is that selecting a real provider never keeps the server from
 * listening. Constructing an adapter must not reach for its CLI: the binary is
 * only spent on a turn, and CI has none.
 */
describe('server startup', () => {
  for (const provider of ['fake', 'claude-code', 'codex'] as const) {
    it(`listens and answers /health with PWB_MODEL_PROVIDER=${provider}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pwb-startup-'));
      // Ephemeral ports: several worktrees of this repo run their suites at once.
      const server = await startServer({
        dbPath: join(directory, 'startup.sqlite'),
        releaseRoot: join(directory, 'releases'),
        evidenceDir: join(directory, 'evidence'),
        apiPort: 0,
        previewPort: 0,
        modelProvider: provider,
      });
      cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });

      const { port } = server.api.address() as AddressInfo;
      expect(port).toBeGreaterThan(0);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe('ok');
    });
  }

  it('refuses an unknown provider name instead of falling back to the fakes', () => {
    expect(() => modelProviderName('claude')).toThrow(/Unknown model provider/);
  });
});
