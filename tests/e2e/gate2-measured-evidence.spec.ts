import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { createFixtureIR, type DesignIR } from '../../packages/domain/src/index.js';
import { RenderHub } from '../../packages/render-hub/src/index.js';
import { RenderHubEvidenceSource } from '../../packages/stage-prototype/src/index.js';
import { createApiServer } from '../../apps/server/src/api.js';
import { openDatabase, ProjectRepository } from '../../apps/server/src/db/repository.js';
import { createPreviewServer } from '../../apps/server/src/preview.js';
import { PrototypeRunRegistry, type Gate2Snapshot } from '../../apps/server/src/prototype-api.js';
import { STUDIO_ORIGIN } from '../../apps/server/src/security.js';

/** The identity whose text and surface roles are both light, so a real browser measures a failing AA pair. */
function createLowContrastIR(): DesignIR {
  const ir = createFixtureIR();
  const color = ir.identity.tokens.color as Record<string, { $value: string; $type: 'color' }>;
  ir.identity.tokens = { ...ir.identity.tokens, color: { ...color, ink: { $value: '#efe9dd', $type: 'color' } } };
  return ir;
}

interface Harness { origin: string; close: () => Promise<void>; }

/**
 * The same wiring `startServer` uses: the registry's evidence is measured by the RenderHub against the
 * isolated preview origin, so the verdict the Gate 2 API reports was observed rather than synthesized.
 */
async function harness(seed?: () => DesignIR): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'pwb-gate2-measured-'));
  const database = openDatabase(join(dir, 'gate2.sqlite'));
  const holder: { registry?: PrototypeRunRegistry } = {};
  const preview = createPreviewServer((versionId) => holder.registry?.preview(versionId), 0);
  await preview.start();
  const { port: previewPort } = preview.server.address() as AddressInfo;
  holder.registry = new PrototypeRunRegistry({
    repository: new ProjectRepository(database),
    evidence: new RenderHubEvidenceSource({
      hub: new RenderHub({ cacheDir: join(dir, 'cache') }),
      baseUrl: `http://127.0.0.1:${previewPort}`,
      previewPrefix: (versionId) => `/preview/${versionId}`,
    }),
    ...(seed ? { seed } : {}),
  });
  const api = createApiServer({
    runs: new Map(), prototypes: holder.registry,
    createRun: () => Promise.reject(new Error('The fixture journey is not part of this test.')),
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const { port } = api.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      await preview.close();
      await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
      database.sqlite.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function post(origin: string, path: string, body: Record<string, unknown>): Promise<{ status: number; payload: Gate2Snapshot & { error?: string } }> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { origin: STUDIO_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() as Gate2Snapshot & { error?: string } };
}

test.describe('Gate 2 runs on measured evidence', () => {
  test.setTimeout(300_000);

  test('takes the three-route prototype through Tier 0 without a veto', async () => {
    const api = await harness();
    try {
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'measured-clean' });
      expect(created.status).toBe(201);
      expect(created.payload.qa.filter((check) => check.severity === 'veto')).toEqual([]);
      expect(created.payload.gate).toBe('needs_review');
      // Every check was written from a real capture, so the matrix really was walked.
      expect(created.payload.qa.length + created.payload.reports.length).toBeGreaterThan(0);
      expect(created.payload.stopReason).toBe('clean');
    } finally { await api.close(); }
  });

  test('vetoes a contrast pair the browser measured below AA, and refuses to approve it', async () => {
    const api = await harness(createLowContrastIR);
    try {
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'measured-contrast' });
      expect(created.status).toBe(201);

      const contrast = created.payload.qa.filter((check) => check.id === 'QA0-CONTRAST');
      expect(contrast.length).toBeGreaterThan(0);
      expect(contrast.every((check) => check.severity === 'veto')).toBe(true);
      expect(contrast[0]!.nodeIds.length).toBeGreaterThan(0);
      expect(created.payload.gate).toBe('vetoed');
      expect(created.payload.stopReason).toBe('tier0_veto');
      // The deterministic veto came before any critic ran.
      expect(created.payload.reports).toEqual([]);

      const approval = await post(api.origin, '/api/prototype/runs/measured-contrast/gate', { approverRole: 'captain', decision: 'approved', rationale: 'Quero aprovar assim mesmo.' });
      expect(approval.status).toBe(409);
      expect(approval.payload.error).toContain('vetoed');
    } finally { await api.close(); }
  });
});
