import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { openDatabase, ProjectRepository } from '../../apps/server/src/db/repository.js';
import { startServer } from '../../apps/server/src/index.js';
import type { IdentityRunSnapshot } from '../../apps/server/src/identity-run.js';
import type { Gate2Snapshot } from '../../apps/server/src/prototype-api.js';
import { STUDIO_ORIGIN } from '../../apps/server/src/security.js';

/**
 * The chain the captain actually walks: an identity approved in Gate 1, a
 * prototype measured on that identity and approved in Gate 2, and a Gate 3
 * report compiled from what came out of it. Each gate is asked for over the
 * product's own HTTP API, with the server wired exactly as `startServer` wires
 * it, so nothing here is a fixture standing in for the captain's work.
 */
interface Harness {
  origin: string;
  dbPath: string;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'pwb-chain-'));
  const dbPath = join(dir, 'chain.sqlite');
  // Port 0 everywhere: several checkouts of this repo run their suites at once.
  const server = await startServer({
    dbPath,
    renderCacheDir: join(dir, 'cache'),
    releaseRoot: join(dir, 'releases'),
    evidenceDir: join(dir, 'evidence'),
    apiPort: 0,
    previewPort: 0,
    modelProvider: 'fake',
  });
  const { port } = server.api.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    dbPath,
    close: async () => { await server.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function post<T>(origin: string, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; payload: T & { error?: string } }> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { origin: STUDIO_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() as T & { error?: string } };
}

async function get<T>(origin: string, path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`);
  return await response.json() as T;
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error('The run never reached the expected state.');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test.describe('identity → prototype → release', () => {
  test.setTimeout(600_000);

  test('publishes through Gate 3 only what Gate 1 approved and Gate 2 measured', async () => {
    const api = await harness();
    try {
      const identityRunId = 'chain-identity';
      const created = await post<IdentityRunSnapshot>(api.origin, '/api/identity/runs', { approverRole: 'captain', runId: identityRunId });
      expect(created.status).toBe(201);

      // Gate 2 has nothing to measure while Gate 1 is undecided.
      const early = await post<Gate2Snapshot>(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'chain-early', identityRunId });
      expect(early.status).toBe(409);
      expect(early.payload.error).toMatch(/Gate 1/);

      await post<IdentityRunSnapshot>(api.origin, `/api/identity/runs/${identityRunId}/start`, { approverRole: 'captain' });
      const proposed = await until(
        () => get<IdentityRunSnapshot>(api.origin, `/api/identity/runs/${identityRunId}`),
        (snapshot) => snapshot.status === 'needs_review' || snapshot.status === 'failed',
        300_000,
      );
      expect(proposed.status).toBe('needs_review');
      const direction = proposed.directions[0]!;
      const approved = await post<IdentityRunSnapshot>(api.origin, `/api/identity/runs/${identityRunId}/approve`, {
        approverRole: 'captain', directionId: direction.directionId, rationale: 'Esta é a identidade do produto.',
      });
      expect(approved.status).toBe(200);
      const handoff = approved.payload.handoff!;
      expect(handoff.stale).toBe(false);

      // Gate 2 starts from the version Gate 1 closed on, named by that execution.
      const prototype = await post<Gate2Snapshot>(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'chain-prototype', identityRunId });
      expect(prototype.status).toBe(201);
      expect(prototype.payload.chain?.identityVersionId).toBe(handoff.versionId);

      const settled = await until(
        () => get<Gate2Snapshot>(api.origin, '/api/prototype/runs/chain-prototype'),
        (snapshot) => snapshot.status !== 'queued' && snapshot.status !== 'running',
        480_000,
      );
      expect(settled.status).toBe('settled');
      // Measured from the revision under review, and it is the identity Gate 1 recorded.
      expect(settled.result!.identityHash).toBe(handoff.identityHash);

      // Gate 3 stays shut until Gate 2 is decided: the approvals table is what it reads.
      const blocked = await post<{ error?: string }>(api.origin, `/api/runs/${identityRunId}/release`);
      expect(blocked.status).toBe(409);
      expect(blocked.payload.error).toMatch(/protótipo/i);

      const gate2 = await post<Gate2Snapshot>(api.origin, '/api/prototype/runs/chain-prototype/gate', {
        approverRole: 'captain', decision: 'approved', rationale: 'O protótipo desta identidade está pronto.',
      });
      expect(gate2.status).toBe(200);
      const prototypeVersionId = gate2.payload.result!.after.versionId;

      // The same chain, now with both gates closed on it, produces the version Gate 3 compiles.
      const chain = await get<{ approvals: Array<{ stage: string; decision: string; versionId: string }> }>(api.origin, `/api/runs/${identityRunId}`);
      expect(chain.approvals.map((entry) => `${entry.stage}:${entry.decision}`)).toContain('prototype:approved');
      const staged = await post<{ currentStage: string }>(api.origin, `/api/runs/${identityRunId}/stage`);
      expect(staged.status).toBe(200);
      expect(staged.payload.currentStage).toBe('finalization');

      const release = await post<{ report: { approvedVersionId: string; releasedVersionId: string } }>(api.origin, `/api/runs/${identityRunId}/release`);
      expect(release.status).toBe(200);

      // What the report names descends from the version approved in Gate 1, through
      // the one approved in Gate 2 — read from the ledger, not from the report.
      const database = openDatabase(api.dbPath);
      try {
        const versions = await new ProjectRepository(database).listVersions(proposed.projectId);
        const byId = new Map(versions.map((version) => [version.id, version]));
        const lineage: string[] = [];
        for (let current = byId.get(release.payload.report.approvedVersionId); current; current = current.parentId ? byId.get(current.parentId) : undefined) lineage.push(current.id);
        expect(lineage).toContain(prototypeVersionId);
        expect(lineage).toContain(handoff.versionId);
      } finally { database.sqlite.close(); }
    } finally { await api.close(); }
  });
});
