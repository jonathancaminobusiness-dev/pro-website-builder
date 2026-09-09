import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { FixtureRun } from './fixture-run.js';
import type { IdentityRun } from './identity-run.js';

describe('configured studio origin', () => {
  it('uses explicitly configured origins for moved-port CORS and CSRF requests', async () => {
    const studioOrigin = 'http://127.0.0.1:5273';
    vi.stubEnv('PWB_STUDIO_ORIGIN', 'http://127.0.0.1:5173');
    vi.stubEnv('PWB_STUDIO_ORIGINS', `http://127.0.0.1:5173, ${studioOrigin}`);
    vi.resetModules();
    const { createApiServer } = await import('./api.js');
    const identityRun = {
      snapshot: () => ({ runId: 'moved-studio-run' }),
      cancel: async () => ({ runId: 'moved-studio-run', status: 'cancelled' }),
    } as unknown as IdentityRun;
    const identityRuns = new Map([['moved-studio-run', identityRun]]);
    const server = createApiServer({
      runs: new Map<string, FixtureRun>(),
      createRun: async () => { throw new Error('unused'); },
      identity: { runs: identityRuns, createRun: async () => identityRun },
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as AddressInfo;
      const apiOrigin = `http://127.0.0.1:${address.port}`;

      const preflight = await fetch(`${apiOrigin}/api/identity/runs`, {
        method: 'OPTIONS',
        headers: {
          origin: studioOrigin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(studioOrigin);

      const fetched = await fetch(`${apiOrigin}/api/identity/runs/moved-studio-run`, { headers: { origin: studioOrigin } });
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('access-control-allow-origin')).toBe(studioOrigin);

      const changed = await fetch(`${apiOrigin}/api/identity/runs/moved-studio-run/cancel`, {
        method: 'POST',
        headers: { origin: studioOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ approverRole: 'captain' }),
      });
      expect(changed.status).toBe(200);

      const crossSite = await fetch(`${apiOrigin}/api/identity/runs/moved-studio-run/cancel`, {
        method: 'POST',
        headers: { origin: 'http://evil.test', 'content-type': 'application/json' },
        body: JSON.stringify({ approverRole: 'captain' }),
      });
      expect(crossSite.status).toBe(403);
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
