import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, type DesignIR } from '@pwb/domain';
import { identityHash } from '@pwb/stage-identity';
import { FakeModelProvider } from '@pwb/providers';
import { DerivedEvidenceSource, type EvidenceSource } from '@pwb/stage-prototype';
import { createApiServer } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';
import { PrototypeRunRegistry, type Gate2Snapshot, type IdentitySeed, type PrototypeRunRequest } from './prototype-api.js';

const captain = { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' };

/**
 * A revision with a defect the critics are guaranteed to report: the grid grammar declares a beat the
 * identity's own spacing roles cannot land on. It is a test fixture, not a second briefing the product
 * offers — the shipped API runs one mode.
 */
function createOffRhythmControlIR(): DesignIR {
  const ir = createFixtureIR();
  const space = ir.identity.tokens.space as Record<string, { $value: string; $type: 'dimension' }>;
  ir.identity.tokens = { ...ir.identity.tokens, space: { ...space, beat: { $value: '0.625rem', $type: 'dimension' } } };
  ir.identity.gridGrammar = { ...ir.identity.gridGrammar, rhythmToken: '{space.beat}' };
  return ir;
}

/** What Gate 1 hands on, as the server reads it back: the approved document, under its own version id. */
function approvedIdentity(overrides: Partial<IdentitySeed> = {}): IdentitySeed {
  const ir = createFixtureIR();
  return { identityRunId: 'identity-chain', projectId: ir.meta.projectId, versionId: ir.meta.versionId, identityHash: identityHash(ir), approvedAt: new Date().toISOString(), stale: false, ir, assets: [], ...overrides };
}

/** An image the art director generated for the approved direction, as Gate 1 hands it on. */
function generatedImagery(): DesignIR['assets']['items'][number] {
  return {
    id: 'identity-hero', kind: 'raster', uri: 'data:image/png;base64,aGVybw==', alt: 'Oficina em operação, luz lateral.',
    provenance: { source: 'higgsfield', author: 'art-director', license: 'higgsfield-commercial', date: new Date().toISOString(), hash: 'h-hero', prompt: 'oficina em operação', model: 'soul' },
    status: 'ready',
  };
}

async function harness(options: { seed?: () => DesignIR; evidence?: EvidenceSource; identity?: (request: PrototypeRunRequest) => Promise<IdentitySeed | undefined> } = {}): Promise<{ origin: string; registry: PrototypeRunRegistry; repository: ProjectRepository; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pwb-gate2-'));
  const db = openDatabase(join(dir, 'gate2.sqlite'));
  const repository = new ProjectRepository(db);
  // Synthesized evidence keeps these unit tests browserless; the server itself only ever measures.
  // Every run starts from an identity Gate 1 approved; a test that wants a
  // document with a known defect hands it over as that approved identity.
  const seeded = options.seed;
  const registry = new PrototypeRunRegistry({
    repository,
    evidence: options.evidence ?? new DerivedEvidenceSource(),
    identity: options.identity ?? (async () => approvedIdentity(seeded ? { ir: seeded() } : {})),
  });
  const runs = new Map<string, FixtureRun>();
  const server = createApiServer({
    runs, prototypes: registry,
    createRun: async (id) => { const run = new FixtureRun({ repository, provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; },
  });
  // Port 0 keeps parallel checkouts off each other's fixed developer ports.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    registry,
    repository,
    close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); db.sqlite.close(); },
  };
}

async function post(origin: string, path: string, body: Record<string, unknown>, headers: Record<string, string> = captain): Promise<{ status: number; payload: Gate2Snapshot & { error?: string } }> {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, payload: await response.json() as Gate2Snapshot & { error?: string } };
}

async function until(origin: string, runId: string, ready: (snapshot: Gate2Snapshot) => boolean): Promise<Gate2Snapshot> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = await (await fetch(`${origin}/api/prototype/runs/${runId}`)).json() as Gate2Snapshot;
    if (ready(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${runId} never reached the expected state.`);
}

/** The screen polls a run until it leaves the queue and settles; so does every test that needs the review. */
async function settled(origin: string, runId: string): Promise<Gate2Snapshot> {
  return until(origin, runId, (snapshot) => snapshot.status !== 'running' && snapshot.status !== 'queued');
}

/** An evidence source the test holds open, so a run can be observed while it is still measuring. */
function blockingEvidence(): { evidence: EvidenceSource; release: () => void } {
  let release = (): void => {};
  const measuring = new Promise<void>((resolve) => { release = resolve; });
  return { evidence: { collect: async (request) => { await measuring; return new DerivedEvidenceSource().collect(request); } }, release: () => release() };
}

describe('Gate 2 API', () => {
  it('starts a prototype run only for the captain and returns everything the gate screen compares', async () => {
    const api = await harness();
    try {
      const refused = await post(api.origin, '/api/prototype/runs', { runId: 'gate2-run' });
      expect(refused.status).toBe(403);
      expect(refused.payload.error).toContain('Only the captain');

      // The start request answers at once with the id, because measuring takes minutes.
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-run', identityRunId: 'identity-chain' });
      expect(created.status).toBe(201);
      expect(created.payload.runId).toBe('gate2-run');
      expect(created.payload.status).toBe('queued');
      expect(created.payload.result).toBeUndefined();

      const duplicate = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-run', identityRunId: 'identity-chain' });
      expect(duplicate.status).toBe(409);
      expect((await fetch(`${api.origin}/api/prototype/runs/absent`)).status).toBe(404);

      const snapshot = await settled(api.origin, 'gate2-run');
      expect(snapshot.status).toBe('settled');
      const result = snapshot.result!;
      expect(result.routes.map((route) => route.route)).toEqual(['/', '/proof', '/contact']);
      // The review offers exactly the widths the gate measured, never one it did not look at.
      expect(result.viewports).toEqual([390, 768, 1440]);
      expect(result.states).toEqual(['default', 'empty', 'error', 'focus', 'loading', 'reduced']);
      expect(result.gate).toBe('needs_review');
      expect(result.qa.filter((check) => check.severity === 'veto')).toEqual([]);
      expect(result.reports).toHaveLength(4);
      expect(result.before.versionId).toMatch(/^v-/);
      expect(result.cycles.length).toBeGreaterThan(0);
    } finally { await api.close(); }
  });

  it('keeps a run reachable by id and in the list while it measures, so a closed tab does not lose it', async () => {
    // The measurement is held open, so the run is observed mid-flight instead of by racing it.
    const held = blockingEvidence();
    const api = await harness({ evidence: held.evidence });
    try {
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-recover', identityRunId: 'identity-chain' });
      expect(created.payload.status).toBe('queued');
      expect(created.payload.result).toBeUndefined();
      await until(api.origin, 'gate2-recover', (snapshot) => snapshot.status === 'running');

      // Nothing can be decided until the stage has actually produced a revision.
      const early = await post(api.origin, '/api/prototype/runs/gate2-recover/gate', { approverRole: 'captain', decision: 'approved', rationale: 'cedo demais' });
      expect(early.status).toBe(409);
      expect(early.payload.error).toContain('running');

      const listing = async (): Promise<Array<{ runId: string; status: string; detail: string }>> =>
        ((await (await fetch(`${api.origin}/api/prototype/runs`)).json()) as { runs: Array<{ runId: string; status: string; detail: string }> }).runs;
      expect(await listing()).toMatchObject([{ runId: 'gate2-recover', status: 'running' }]);

      held.release();
      expect((await settled(api.origin, 'gate2-recover')).status).toBe('settled');
      const listed = await listing();
      expect(listed).toMatchObject([{ runId: 'gate2-recover', status: 'settled' }]);
      expect(listed.every((entry) => entry.detail !== '')).toBe(true);
    } finally { await api.close(); }
  });

  it('measures one revision at a time and queues the next behind it', async () => {
    const held = blockingEvidence();
    const api = await harness({ evidence: held.evidence });
    try {
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-first', identityRunId: 'identity-chain' });
      await until(api.origin, 'gate2-first', (snapshot) => snapshot.status === 'running');
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-second', identityRunId: 'identity-chain' });

      // The second run holds no browser: it waits for the only measuring slot the server has.
      for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      const queued = await (await fetch(`${api.origin}/api/prototype/runs/gate2-second`)).json() as Gate2Snapshot;
      expect(queued.status).toBe('queued');
      expect((await (await fetch(`${api.origin}/api/prototype/runs/gate2-first`)).json() as Gate2Snapshot).status).toBe('running');

      held.release();
      expect((await settled(api.origin, 'gate2-first')).status).toBe('settled');
      expect((await settled(api.origin, 'gate2-second')).status).toBe('settled');
    } finally { await api.close(); }
  });

  it('serves both sides of the comparison from the isolated preview origin', async () => {
    const api = await harness();
    try {
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-preview', identityRunId: 'identity-chain' });
      const result = (await settled(api.origin, 'gate2-preview')).result!;
      for (const versionId of [result.before.versionId, result.after.versionId]) {
        const document = api.registry.preview(versionId);
        expect(document?.routes.map((route) => route.route)).toEqual(['/', '/proof', '/contact']);
      }
      expect(api.registry.preview('v-does-not-exist')).toBeUndefined();
    } finally { await api.close(); }
  });

  it('records an issue decision with a reason and refuses one without', async () => {
    // Driven from a revision with a known defect, so the run always carries a finding to decide on.
    const api = await harness({ seed: createOffRhythmControlIR });
    try {
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-decide', identityRunId: 'identity-chain' });
      const findingId = (await settled(api.origin, 'gate2-decide')).result!.issues[0]!.id;
      const path = '/api/prototype/runs/gate2-decide/decision';

      expect((await post(api.origin, path, { approverRole: 'captain', findingId, decision: 'accepted', rationale: '  ' })).status).toBe(400);
      expect((await post(api.origin, path, { approverRole: 'designer', findingId, decision: 'accepted', rationale: 'ok' })).status).toBe(403);
      expect((await post(api.origin, path, { approverRole: 'captain', findingId: 'ghost-finding', decision: 'accepted', rationale: 'ok' })).status).toBe(400);
      expect((await post(api.origin, path, { approverRole: 'captain', findingId, decision: 'maybe', rationale: 'ok' })).status).toBe(400);

      const decided = await post(api.origin, path, { approverRole: 'captain', findingId, decision: 'deferred', rationale: 'Sem tempo de revisar agora.' });
      expect(decided.payload.result!.decisions).toHaveLength(1);
      expect(decided.payload.result!.decisions[0]).toMatchObject({ findingId, decision: 'deferred', rationale: 'Sem tempo de revisar agora.', reviewerRole: 'captain' });
    } finally { await api.close(); }
  });

  it('records the gate decision against the reviewed revision and keeps it captain-only', async () => {
    const api = await harness();
    try {
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-gate', identityRunId: 'identity-chain' });
      const created = await settled(api.origin, 'gate2-gate');
      const path = '/api/prototype/runs/gate2-gate/gate';
      expect((await post(api.origin, path, { approverRole: 'captain', decision: 'maybe', rationale: 'ok' })).status).toBe(400);
      expect((await post(api.origin, path, { approverRole: 'designer', decision: 'approved', rationale: 'ok' })).status).toBe(403);

      const approved = await post(api.origin, path, { approverRole: 'captain', decision: 'approved', rationale: 'Hierarquia e caráter aprovados.' });
      expect(approved.status).toBe(200);
      expect(approved.payload.result!.approval).toMatchObject({ decision: 'approved', versionId: created.result!.after.versionId, approverRole: 'captain', stage: 'prototype' });
    } finally { await api.close(); }
  });

  it('serves a settled review again after a restart, and marks an unfinished run interrupted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-gate2-restart-'));
    const db = openDatabase(join(dir, 'restart.sqlite'));
    const repository = new ProjectRepository(db);
    const held = blockingEvidence();
    try {
      const first = new PrototypeRunRegistry({ repository, evidence: new DerivedEvidenceSource(), identity: async () => approvedIdentity({ ir: createOffRhythmControlIR() }) });
      await first.create('gate2-restart', { identityRunId: 'identity-chain' });
      let before = first.get('gate2-restart')!;
      for (let attempt = 0; attempt < 400 && (before.status === 'running' || before.status === 'queued'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        before = first.get('gate2-restart')!;
      }
      await first.decide('gate2-restart', { findingId: before.result!.issues[0]!.id, decision: 'accepted', rationale: 'Reparo causal aceito.' });

      // A run that never finished measuring when the process stopped.
      const stopped = new PrototypeRunRegistry({ repository, evidence: held.evidence, identity: async () => approvedIdentity() });
      await stopped.create('gate2-interrupted', { identityRunId: 'identity-chain' });

      // A new process reads the same database and serves the review without measuring anything again.
      const restarted = new PrototypeRunRegistry({ repository, evidence: new DerivedEvidenceSource(), identity: async () => approvedIdentity() });
      await restarted.restore();

      const recovered = restarted.get('gate2-restart')!;
      expect(recovered.status).toBe('settled');
      expect(recovered.result!.stopReason).toBe(before.result!.stopReason);
      expect(recovered.result!.viewports).toEqual([390, 768, 1440]);
      expect(recovered.result!.decisions).toHaveLength(1);
      // Both sides of the comparison still render, so the preview origin can serve A and B.
      for (const versionId of [recovered.result!.before.versionId, recovered.result!.after.versionId]) {
        expect(restarted.preview(versionId)?.routes.map((route) => route.route)).toEqual(['/', '/proof', '/contact']);
      }

      const interrupted = restarted.get('gate2-interrupted')!;
      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.result).toBeUndefined();
      expect(restarted.list().map((entry) => entry.runId).sort()).toEqual(['gate2-interrupted', 'gate2-restart']);
    } finally {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      db.sqlite.close();
    }
  });

  it('writes the gate history to the event log without leaking a credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-gate2-events-'));
    const db = openDatabase(join(dir, 'events.sqlite'));
    const repository = new ProjectRepository(db);
    try {
      const registry = new PrototypeRunRegistry({ repository, evidence: new DerivedEvidenceSource(), identity: async () => approvedIdentity({ ir: createOffRhythmControlIR() }) });
      await registry.create('gate2-events', { identityRunId: 'identity-chain' });
      let snapshot = registry.get('gate2-events')!;
      for (let attempt = 0; attempt < 200 && snapshot.status === 'running'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        snapshot = registry.get('gate2-events')!;
      }
      await registry.decide('gate2-events', { findingId: snapshot.result!.issues[0]!.id, decision: 'accepted', rationale: 'Reparo causal aceito.' });
      await registry.settle('gate2-events', { decision: 'approved', rationale: 'Aprovado.' });
      const types = (await repository.listEvents('gate2-events')).map((event) => event.type);
      expect(types).toContain('prototype.run.started');
      expect(types).toContain('prototype.qa.gate');
      expect(types).toContain('prototype.stage.settled');
      expect(types).toContain('gate2.decided');
      expect(repository.dump()).not.toMatch(/(api[_-]?key|password|secret)["']?\s*[:=]/i);
    } finally { db.sqlite.close(); }
  });
});

describe('Gate 2 runs on the identity Gate 1 approved', () => {
  it('composes over the imagery Gate 1 generated, not over the placeholders it replaces', async () => {
    // The identity stage may not write `/assets`, so its imagery reaches the
    // document only through the handoff this seed carries.
    const hero = generatedImagery();
    const seed = approvedIdentity({ assets: [hero] });
    const api = await harness({ identity: async () => seed });
    try {
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-imagery', identityRunId: 'identity-chain' });
      const result = (await settled(api.origin, 'gate2-imagery')).result!;
      await post(api.origin, '/api/prototype/runs/gate2-imagery/gate', { approverRole: 'captain', decision: 'approved', rationale: 'Protótipo aprovado.' });

      // The revision the captain reviewed carries it, so the bundle Gate 3
      // compiles ships the identity's own image rather than the fixture's.
      const versions = await api.repository.listVersions(seed.projectId);
      const reviewed = versions.find((version) => version.id === result.after.versionId)!;
      expect(reviewed.ir.assets.items.find((asset) => asset.id === hero.id)).toMatchObject({ uri: hero.uri, alt: hero.alt });
      // And it replaced the placeholder of that id instead of doubling it.
      expect(reviewed.ir.assets.items.filter((asset) => asset.id === hero.id)).toHaveLength(1);
    } finally { await api.close(); }
  });

  it('refuses to measure anything the captain has not approved in Gate 1', async () => {
    const api = await harness({ identity: async () => undefined });
    try {
      // No identity named at all: the stage has nothing to prototype, and answering
      // with the built-in fixture would be measuring work the captain never asked for.
      const unnamed = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-unnamed' });
      expect(unnamed.status).toBe(409);
      expect(unnamed.payload.error).toMatch(/identidade aprovada/i);

      const undecided = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-undecided', identityRunId: 'identity-chain' });
      expect(undecided.status).toBe(409);
      expect(undecided.payload.error).toMatch(/Gate 1/);
      expect(api.registry.has('gate2-undecided')).toBe(false);
    } finally { await api.close(); }
  });

  it('refuses an identity that moved after the gate closed, and one the gate did not close on', async () => {
    const api = await harness({ identity: async () => approvedIdentity({ stale: true }) });
    try {
      const stale = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-stale', identityRunId: 'identity-chain' });
      expect(stale.status).toBe(409);
      expect(stale.payload.error).toMatch(/mudou depois do Gate 1/i);
    } finally { await api.close(); }

    const fresh = await harness({ identity: async () => approvedIdentity() });
    try {
      const other = await post(fresh.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-other', identityRunId: 'identity-chain', versionId: 'v-nao-aprovada' });
      expect(other.status).toBe(409);
      expect(other.payload.error).toMatch(/aprovou a versão/i);
    } finally { await fresh.close(); }
  });

  it('seeds the run from the approved version and records Gate 2 in the chain ledger', async () => {
    const seed = approvedIdentity();
    const asked: PrototypeRunRequest[] = [];
    const api = await harness({ identity: async (request) => { asked.push(request); return seed; } });
    try {
      // The approved version is named by the Gate 1 execution; asking by the
      // version alone reaches the same run.
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-chain', identityRunId: 'identity-chain' });
      expect(created.status).toBe(201);
      expect(created.payload.chain).toEqual({ identityRunId: 'identity-chain', identityVersionId: seed.versionId, identityHash: seed.identityHash, projectId: seed.projectId });
      expect(asked).toEqual([{ identityRunId: 'identity-chain' }]);

      const snapshot = await settled(api.origin, 'gate2-chain');
      const result = snapshot.result!;
      // Measured from the document under review, never copied from the request:
      // the prototype stage may not write `/identity`, and this proves it did not.
      expect(result.identityHash).toBe(seed.identityHash);

      const approved = await post(api.origin, '/api/prototype/runs/gate2-chain/gate', { approverRole: 'captain', decision: 'approved', rationale: 'Protótipo aprovado sobre a identidade aprovada.' });
      expect(approved.status).toBe(200);

      // The approval lands in the table Gate 3 reads, under the chain's own run id.
      const approvals = await api.repository.listApprovals('identity-chain');
      expect(approvals.map((entry) => [entry.stage, entry.decision, entry.versionId])).toEqual([['prototype', 'approved', result.after.versionId]]);

      // A second tab still holding the pre-decision snapshot cannot overwrite the
      // row the release gate reads: the decision stands and the tab is told so.
      const again = await post(api.origin, '/api/prototype/runs/gate2-chain/gate', { approverRole: 'captain', decision: 'rejected', rationale: 'Devolver para revisão.' });
      expect(again.status).toBe(409);
      expect(again.payload.error).toMatch(/já foi aprovado/i);
      expect((await api.repository.listApprovals('identity-chain')).map((entry) => [entry.stage, entry.decision])).toEqual([['prototype', 'approved']]);
      expect((await settled(api.origin, 'gate2-chain')).result!.approval).toMatchObject({ decision: 'approved' });

      // And so does the lineage between the two, so Gate 3 can walk it.
      const versions = await api.repository.listVersions(seed.projectId);
      const byId = new Map(versions.map((version) => [version.id, version]));
      expect(byId.has(seed.versionId)).toBe(true);
      const lineage: string[] = [];
      for (let current = byId.get(result.after.versionId); current; current = current.parentId ? byId.get(current.parentId) : undefined) lineage.push(current.id);
      expect(lineage.at(-1)).toBe(seed.versionId);
    } finally { await api.close(); }
  });
});
