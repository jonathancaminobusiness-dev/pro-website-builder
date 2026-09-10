import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { FixtureRun } from './fixture-run.js';
import type { IdentityRun } from './identity-run.js';

describe('configured Studio origins', () => {
  it('allows only the primary and diagnostic origins across CORS and CSRF boundaries', async () => {
    const primaryOrigin = 'http://127.0.0.1:5173';
    const diagnosticOrigin = 'http://127.0.0.1:5273';
    vi.stubEnv('PWB_STUDIO_ORIGIN', diagnosticOrigin);
    vi.stubEnv('PWB_STUDIO_ORIGINS', primaryOrigin);
    vi.resetModules();
    const [{ createApiServer }, { previewHeaders }] = await Promise.all([
      import('./api.js'),
      import('./security.js'),
    ]);
    const identityRun = {
      snapshot: () => ({ runId: 'moved-studio-run' }),
      cancel: async () => ({ runId: 'moved-studio-run', status: 'cancelled' }),
    } as unknown as IdentityRun;
    const server = createApiServer({
      runs: new Map<string, FixtureRun>(),
      createRun: async () => { throw new Error('unused'); },
      identity: { runs: new Map([['moved-studio-run', identityRun]]), createRun: async () => identityRun },
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as AddressInfo;
      const apiOrigin = `http://127.0.0.1:${address.port}`;
      const preflight = async (origin: string): Promise<Response> => fetch(`${apiOrigin}/api/identity/runs`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'content-type',
        },
      });
      const fetched = async (origin: string): Promise<Response> => fetch(`${apiOrigin}/api/identity/runs/moved-studio-run`, { headers: { origin } });
      const changed = async (origin: string): Promise<Response> => fetch(`${apiOrigin}/api/identity/runs/moved-studio-run/cancel`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ approverRole: 'captain' }),
      });

      for (const origin of [diagnosticOrigin, primaryOrigin]) {
        const response = await preflight(origin);
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe(origin);
        expect(response.headers.get('vary')).toBe('Origin');

        const read = await fetched(origin);
        expect(read.status).toBe(200);
        expect(read.headers.get('access-control-allow-origin')).toBe(origin);
        expect(read.headers.get('vary')).toBe('Origin');

        expect((await changed(origin)).status).toBe(200);
      }

      const unlistedOrigin = 'http://evil.test';
      const unlistedPreflight = await preflight(unlistedOrigin);
      expect(unlistedPreflight.status).toBe(204);
      expect(unlistedPreflight.headers.get('access-control-allow-origin')).toBeNull();
      expect(unlistedPreflight.headers.get('vary')).toBe('Origin');

      const unlistedRead = await fetched(unlistedOrigin);
      expect(unlistedRead.status).toBe(200);
      expect(unlistedRead.headers.get('access-control-allow-origin')).toBeNull();
      expect(unlistedRead.headers.get('vary')).toBe('Origin');

      const unlistedChange = await changed(unlistedOrigin);
      expect(unlistedChange.status).toBe(403);
      expect(unlistedChange.headers.get('access-control-allow-origin')).toBeNull();

      const frameAncestors = previewHeaders()['Content-Security-Policy']!
        .split(';')
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith('frame-ancestors'));
      expect(frameAncestors).toBe(`frame-ancestors ${diagnosticOrigin} ${primaryOrigin}`);
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it.each([
    ['PWB_STUDIO_ORIGIN', '*'],
    ['PWB_STUDIO_ORIGIN', 'null'],
    ['PWB_STUDIO_ORIGIN', 'http://127.0.0.1:5273/path'],
    ['PWB_STUDIO_ORIGIN', 'ftp://127.0.0.1:5273'],
    ['PWB_STUDIO_ORIGINS', '*'],
    ['PWB_STUDIO_ORIGINS', 'null'],
    ['PWB_STUDIO_ORIGINS', 'http://127.0.0.1:5273/path'],
    ['PWB_STUDIO_ORIGINS', 'ftp://127.0.0.1:5273'],
  ])('rejects malformed %s value %s', async (variable, value) => {
    vi.stubEnv(variable, value);
    vi.resetModules();
    try {
      await expect(import('./security.js')).rejects.toThrow(variable);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
