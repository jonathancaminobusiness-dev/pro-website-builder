import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelProvider } from '@pwb/providers';
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
    const reopened = await run.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
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
    const reopened = await run.changeToken({ tokenPath: 'color.paper', value: '#ffffff', rationale: 'Papel mais claro.' });
    expect(reopened.handoff?.stale).toBe(true);
  });

  it('persists the re-approval that closes a reopened gate as its own decision', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    const first = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });
    await run.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
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

  it('shows every colour token on the card, including one a director nested', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-director-editorial-material' || !result.proposal) return result;
        const identity = result.proposal.operations[0]!.value as { tokens: { color: Record<string, unknown> } };
        const tokens = { ...identity.tokens, color: { ...identity.tokens.color, brand: { primary: { $value: '#b4552f', $type: 'color' } } } };
        return { ...result, proposal: { ...result.proposal, operations: [{ op: 'replace', path: '/identity', value: { ...identity, tokens } }] } };
      },
    };
    const run = new IdentityRun({ runId: 'nested-color', repository: new ProjectRepository(database), provider });
    await run.initialize();
    const started = await run.start();
    const card = started.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(card.swatches.find((swatch) => swatch.path === 'color.brand.primary')?.value).toBe('#b4552f');
    expect(card.swatches.every((swatch) => swatch.value !== 'undefined')).toBe(true);
  });

  it('re-derives the chosen card from the version a token change produced', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    const approved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });
    const before = approved.directions.find((direction) => direction.directionId === 'editorial-material')!;
    if (approved.gate.state !== 'closed') throw new Error('unreachable');
    // A closed gate already moved the chosen card onto the approved version.
    expect(before.versionId).toBe(approved.gate.record.versionId);
    expect(before.identityHash).toBe(approved.gate.record.identityHash);

    const reopened = await run.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    const chosen = reopened.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(chosen.versionId).toBe(reopened.previewVersionId);
    expect(chosen.identityHash).not.toBe(before.identityHash);
    expect(chosen.swatches.find((swatch) => swatch.path === 'color.accent')?.value).toBe('#ff7a00');

    // The blocker the server will refuse the approval with is on the card first.
    const withForbiddenFont = await run.changeToken({ tokenPath: 'type.display', value: 'Inter-only hero, Georgia, serif', rationale: 'Testando a fonte proibida.' });
    const blocked = withForbiddenFont.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(blocked.lintErrors.map((finding) => finding.id)).toContain('DEF-010');
    await expect(run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Mesmo assim.' })).rejects.toThrow(/automatic selection is not allowed/);

    // The other two cards stay the historical candidates the captain compared.
    const other = withForbiddenFont.directions.find((direction) => direction.directionId === 'modular-technical')!;
    expect(other.versionId).not.toBe(withForbiddenFont.previewVersionId);
    expect(other.lintErrors).toEqual([]);

    // Re-approving closes the gate onto that same version, and the card follows it.
    const reapproved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Revisado.', overrideRationale: 'A fonte proibida é intencional neste teste.' });
    if (reapproved.gate.state !== 'closed') throw new Error('unreachable');
    const closed = reapproved.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(closed.versionId).toBe(reapproved.gate.record.versionId);
    expect(closed.identityHash).toBe(reapproved.gate.record.identityHash);
    expect(closed.swatches.find((swatch) => swatch.path === 'color.accent')?.value).toBe('#ff7a00');
  });

  it('drops the render cache entries the approved identity produced when a token changes', async () => {
    const cacheDir = join(directory, 'render-cache');
    await mkdir(cacheDir, { recursive: true });
    const run = new IdentityRun({ runId: 'identity-prune', repository: new ProjectRepository(database), provider: new FakeIdentityProvider(), renderCacheDir: cacheDir });
    await run.initialize();
    await run.start();
    await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });

    // The stale keys belong to the approved version, so a first change names the
    // same entries a later one has to remove.
    const reopened = await run.changeToken({ tokenPath: 'color.paper', value: '#ffffff', rationale: 'Papel mais claro.' });
    if (reopened.gate.state !== 'reopened') throw new Error('the gate should have reopened');
    const keys = reopened.gate.impact.staleRenderKeys;
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) await writeFile(join(cacheDir, `${key}.json`), '{}', 'utf8');
    await writeFile(join(cacheDir, 'unrelated.json'), '{}', 'utf8');

    await run.changeToken({ tokenPath: 'color.paper', value: '#fefefe', rationale: 'Papel ainda mais claro.' });
    expect(await readdir(cacheDir)).toEqual(['unrelated.json']);
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

      const reopened = await post(origin, '/api/identity/runs/api-run/token', { approverRole: 'captain', tokenPath: 'color.ink', value: '#111111', rationale: 'Tinta mais escura.' });
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

  it('rejects a token change that carries anything but a value', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'bad-token' });
      await post(origin, '/api/identity/runs/bad-token/start', { approverRole: 'captain' });
      await post(origin, '/api/identity/runs/bad-token/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'ok' });
      // The caller does not get to declare the token's type; it sends the value the approved token takes.
      const response = await post(origin, '/api/identity/runs/bad-token/token', { approverRole: 'captain', tokenPath: 'color.ink', value: { $value: '#000000', $type: 'dimension' } });
      expect(response.status).toBe(400);
    });
  });

  it('answers 400 when the captain approves a blocked direction without an override', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'blocked-gate' });
      await post(origin, '/api/identity/runs/blocked-gate/start', { approverRole: 'captain' });
      await post(origin, '/api/identity/runs/blocked-gate/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'ok' });
      await post(origin, '/api/identity/runs/blocked-gate/token', { approverRole: 'captain', tokenPath: 'type.display', value: 'Inter-only hero, Georgia, serif' });
      const refused = await post(origin, '/api/identity/runs/blocked-gate/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'Mesmo assim.' });
      expect(refused.status).toBe(400);
      expect((await refused.json() as { error: string }).error).toMatch(/automatic selection is not allowed/);
    });
  });

  it('refuses a value the approved token cannot take with a 400 and the reason', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'typed-token' });
      await post(origin, '/api/identity/runs/typed-token/start', { approverRole: 'captain' });
      await post(origin, '/api/identity/runs/typed-token/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'ok' });
      const response = await post(origin, '/api/identity/runs/typed-token/token', { approverRole: 'captain', tokenPath: 'space.md', value: '#ff7a00' });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toMatch(/dimension token expects/);
    });
  });

  it('answers 404 for an unknown identity run', async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/identity/runs/ghost`, { headers: { origin: STUDIO_ORIGIN } });
      expect(response.status).toBe(404);
    });
  });
});
