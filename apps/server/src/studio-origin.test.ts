import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { FixtureRun } from './fixture-run.js';
import type { IdentityRun } from './identity-run.js';

describe('configured studio origin', () => {
  it('uses explicitly configured origins for moved-port CORS and CSRF requests', async () => {
    const primaryOrigin = 'http://127.0.0.1:5173';
    const studioOrigin = 'http://127.0.0.1:5273';
    vi.stubEnv('PWB_STUDIO_ORIGINS', studioOrigin);
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

      const primaryFetched = await fetch(`${apiOrigin}/api/identity/runs/moved-studio-run`, { headers: { origin: primaryOrigin } });
      expect(primaryFetched.status).toBe(200);
      expect(primaryFetched.headers.get('access-control-allow-origin')).toBe(primaryOrigin);

      const changed = await fetch(`${apiOrigin}/api/identity/runs/moved-studio-run/cancel`, {
        method: 'POST',
        headers: { origin: studioOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ approverRole: 'captain' }),
      });
      expect(changed.status).toBe(200);

      const primaryChanged = await fetch(`${apiOrigin}/api/identity/runs/moved-studio-run/cancel`, {
        method: 'POST',
        headers: { origin: primaryOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ approverRole: 'captain' }),
      });
      expect(primaryChanged.status).toBe(200);

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

  it.each([
    'null',
    '*',
    'http://127.0.0.1:5273/path',
    'ftp://127.0.0.1:5273',
  ])('rejects malformed diagnostic origin %s', async (origin) => {
    vi.stubEnv('PWB_STUDIO_ORIGINS', origin);
    vi.resetModules();
    try {
      await expect(import('./security.js')).rejects.toThrow('PWB_STUDIO_ORIGINS');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('rejects a malformed primary Studio origin', async () => {
    vi.stubEnv('PWB_STUDIO_ORIGIN', 'http://127.0.0.1:5173/path');
    vi.resetModules();
    try {
      await expect(import('./security.js')).rejects.toThrow('PWB_STUDIO_ORIGIN');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
