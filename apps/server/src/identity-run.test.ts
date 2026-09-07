import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeIdentityProvider } from '@pwb/stage-identity';
import { startServer } from './index.js';
import { openDatabase, ProjectRepository, type LocalDatabase } from './db/repository.js';
import { IdentityRun } from './identity-run.js';
import { STUDIO_ORIGIN } from './security.js';

let directory: string;
let database: LocalDatabase;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pwb-identity-'));
  database = openDatabase(join(directory, 'identity.sqlite'));
});

afterEach(async () => {
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

function newRun(runId = 'identity-test'): IdentityRun {
  return new IdentityRun({ runId, repository: new ProjectRepository(database), provider: new FakeIdentityProvider() });
}

describe('identity run', () => {
  it('spends no model turn until the captain starts it', async () => {
    const run = newRun();
    await run.initialize();
    expect(run.snapshot().status).toBe('queued');
    expect(run.snapshot().directions).toEqual([]);
    const started = await run.start();
    expect(started.status).toBe('needs_review');
    expect(started.directions).toHaveLength(3);
  });

  it('persists every candidate version and the events behind the fan-out', async () => {
    const repository = new ProjectRepository(database);
    const run = new IdentityRun({ runId: 'identity-events', repository, provider: new FakeIdentityProvider() });
    await run.initialize();
    const snapshot = await run.start();
    const stored = database.sqlite.prepare('SELECT id, parent_id FROM versions').all() as Array<{ id: string; parent_id: string | null }>;
    for (const direction of snapshot.directions) expect(stored.some((row) => row.id === direction.versionId)).toBe(true);
    expect(stored.filter((row) => row.parent_id === snapshot.baseVersionId)).toHaveLength(3);
    const events = await repository.listEvents('identity-events');
    expect(events.map((event) => event.type)).toContain('identity.stage.started');
    expect(events.filter((event) => event.type === 'identity.candidate.opened')).toHaveLength(3);
    expect(events.some((event) => event.type === 'identity.stage.gate_opened')).toBe(true);
  });

  it('gives the Gate 1 screen three directions with rationale, exclusions and axes', async () => {
    const run = newRun();
    await run.initialize();
    const snapshot = await run.start();
    expect(snapshot.divergence?.passed).toBe(true);
    for (const direction of snapshot.directions) {
      expect(direction.axes).toHaveLength(6);
      expect(direction.rationale.length).toBeGreaterThan(10);
      expect(direction.exclusions.length).toBeGreaterThan(0);
      expect(direction.forbiddenDefaults.palettes.length).toBeGreaterThan(0);
      expect(direction.decisions.length).toBeGreaterThan(10);
      expect(direction.lintErrors).toEqual([]);
      expect(direction.swatches.length).toBeGreaterThan(0);
    }
  });

  it('records the captain decision and serves the approved version to the preview', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    const approved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'A oficina editorial responde ao briefing.' });
    expect(approved.status).toBe('approved');
    expect(approved.approvals[0]).toMatchObject({ stage: 'identity', approverRole: 'captain', decision: 'approved' });
    expect(approved.gate.state).toBe('closed');
    expect(run.renderedFor(approved.previewVersionId!)).toBeDefined();
    expect(approved.assets[0]?.provenance.license).toBeTruthy();
  });

  it('reopens the gate when a token changes after approval', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    await run.approve({ directionId: 'modular-technical', approverRole: 'captain', rationale: 'Aprovada.' });
    const reopened = await run.changeToken({ tokenPath: 'color.accent', value: { $value: '#ff7a00', $type: 'color' }, rationale: 'Sinal mais quente.' });
    expect(reopened.status).toBe('reopened');
    expect(reopened.gate.state).toBe('reopened');
    if (reopened.gate.state !== 'reopened') throw new Error('unreachable');
    expect(reopened.gate.impact.changedTokenPaths).toEqual(['color.accent']);
    expect(reopened.gate.impact.staleRenderKeys.length).toBeGreaterThan(0);
  });

  it('hands the next stage the approved version and marks it stale when a token moves', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });
    const handed = run.snapshot().handoff!;
    expect(handed.stale).toBe(false);
    expect(handed.directionId).toBe('editorial-material');
    const reopened = await run.changeToken({ tokenPath: 'color.paper', value: { $value: '#ffffff', $type: 'color' }, rationale: 'Papel mais claro.' });
    expect(reopened.handoff?.stale).toBe(true);
  });

  it('persists the re-approval that closes a reopened gate as its own decision', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    const first = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });
    await run.changeToken({ tokenPath: 'color.accent', value: { $value: '#ff7a00', $type: 'color' }, rationale: 'Sinal mais quente.' });
    const reapproved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Token revisado e aprovado.' });
    expect(reapproved.gate.state).toBe('closed');

    const rows = database.sqlite.prepare("SELECT id, version_id, rationale FROM approvals WHERE decision = 'approved' ORDER BY rowid").all() as Array<{ id: string; version_id: string; rationale: string }>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows[1]?.version_id).not.toBe(rows[0]?.version_id);
    expect(rows[1]?.rationale).toBe('Token revisado e aprovado.');
    if (first.gate.state !== 'closed') throw new Error('unreachable');
    expect(rows[0]?.version_id).toBe(first.gate.record.versionId);
    expect(new Set(reapproved.approvals.map((approval) => approval.id)).size).toBe(2);
  });

  it('reports only the render cache entries it actually removed', async () => {
    const run = new IdentityRun({ runId: 'identity-prune', repository: new ProjectRepository(database), provider: new FakeIdentityProvider(), renderCacheDir: join(directory, 'render-cache') });
    await run.initialize();
    await run.start();
    await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });
    const reopened = await run.changeToken({ tokenPath: 'color.paper', value: { $value: '#ffffff', $type: 'color' }, rationale: 'Papel mais claro.' });
    // Nothing was ever rendered for this run, so nothing was pruned; the count is
    // what left the cache, not how many keys were tried.
    expect(reopened.gate.state).toBe('reopened');
    expect(reopened.prunedRenders).toBe(0);
  });

  it('refuses a rejection from anyone but the captain', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    await expect(run.reject({ directionId: 'editorial-material', approverRole: 'designer', rationale: 'não' })).rejects.toThrow(/Only the captain/);
  });
});

describe('identity api', () => {
  // Ephemeral ports: several worktrees of this repo run their suites on one machine.
  async function withServer<T>(work: (origin: string) => Promise<T>): Promise<T> {
    const server = await startServer({ dbPath: join(directory, 'api.sqlite'), exportRoot: join(directory, 'exports'), apiPort: 0, previewPort: 0 });
    const { port } = server.api.address() as AddressInfo;
    try { return await work(`http://127.0.0.1:${port}`); } finally { await server.close(); }
  }

  const post = (origin: string, path: string, payload: unknown) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: STUDIO_ORIGIN }, body: JSON.stringify(payload) });

  it('drives one run from creation to an approved gate and back open', async () => {
    await withServer(async (origin) => {
      const created = await post(origin, '/api/identity/runs', { runId: 'api-run' });
      expect(created.status).toBe(201);
      expect((await created.json() as { status: string }).status).toBe('queued');

      const started = await post(origin, '/api/identity/runs/api-run/start', { approverRole: 'captain' });
      const startedBody = await started.json() as { status: string; directions: Array<{ directionId: string }>; divergence: { passed: boolean } };
      expect(started.status).toBe(200);
      expect(startedBody.status).toBe('needs_review');
      expect(startedBody.directions).toHaveLength(3);
      expect(startedBody.divergence.passed).toBe(true);

      const approved = await post(origin, '/api/identity/runs/api-run/approve', { approverRole: 'captain', directionId: 'typographic-low-chroma', rationale: 'Aprovada.' });
      expect((await approved.json() as { gate: { state: string } }).gate.state).toBe('closed');

      const reopened = await post(origin, '/api/identity/runs/api-run/token', { approverRole: 'captain', tokenPath: 'color.ink', value: { $value: '#111111', $type: 'color' }, rationale: 'Tinta mais escura.' });
      expect((await reopened.json() as { gate: { state: string } }).gate.state).toBe('reopened');

      const fetched = await fetch(`${origin}/api/identity/runs/api-run`, { headers: { origin: STUDIO_ORIGIN } });
      expect((await fetched.json() as { status: string }).status).toBe('reopened');
    });
  });

  it('refuses a start, an approval and a token change from anyone but the captain', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'guarded' });
      for (const [path, payload] of [
        ['/api/identity/runs/guarded/start', {}],
        ['/api/identity/runs/guarded/approve', { directionId: 'editorial-material' }],
        ['/api/identity/runs/guarded/token', { tokenPath: 'color.ink', value: { $value: '#000000' } }],
      ] as const) {
        const response = await post(origin, path, { ...payload, approverRole: 'designer' });
        expect(response.status).toBe(403);
      }
    });
  });

  it('refuses a state-changing identity request from another origin', async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/identity/runs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
      expect(response.status).toBe(403);
    });
  });

  it('rejects a token change whose value is not a DTCG token', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'bad-token' });
      await post(origin, '/api/identity/runs/bad-token/start', { approverRole: 'captain' });
      await post(origin, '/api/identity/runs/bad-token/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'ok' });
      const response = await post(origin, '/api/identity/runs/bad-token/token', { approverRole: 'captain', tokenPath: 'color.ink', value: '#000000' });
      expect(response.status).toBe(400);
    });
  });

  it('answers 404 for an unknown identity run', async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/identity/runs/ghost`, { headers: { origin: STUDIO_ORIGIN } });
      expect(response.status).toBe(404);
    });
  });
});
