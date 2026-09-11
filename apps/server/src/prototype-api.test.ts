import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, type DesignIR } from '@pwb/domain';
import { FakeModelProvider } from '@pwb/providers';
import { DerivedEvidenceSource, type EvidenceSource } from '@pwb/stage-prototype';
import { createApiServer } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';
import { PrototypeRunRegistry, type Gate2Snapshot } from './prototype-api.js';

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

async function harness(options: { seed?: () => DesignIR; evidence?: EvidenceSource; decorate?: (repository: ProjectRepository) => ProjectRepository } = {}): Promise<{ origin: string; registry: PrototypeRunRegistry; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pwb-gate2-'));
  const db = openDatabase(join(dir, 'gate2.sqlite'));
  const stored = new ProjectRepository(db);
  const repository = options.decorate ? options.decorate(stored) : stored;
  // Synthesized evidence keeps these unit tests browserless; the server itself only ever measures.
  const registry = new PrototypeRunRegistry({ repository, evidence: options.evidence ?? new DerivedEvidenceSource(), ...(options.seed ? { seed: options.seed } : {}) });
  const runs = new Map<string, FixtureRun>();
  const server = createApiServer({
    runs, prototypes: registry,
    createRun: async (id) => { const run = new FixtureRun({ modelProvider: 'fake', repository: stored, provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; },
  });
  // Port 0 keeps parallel checkouts off each other's fixed developer ports.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    registry,
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
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-run' });
      expect(created.status).toBe(201);
      expect(created.payload.runId).toBe('gate2-run');
      expect(created.payload.status).toBe('queued');
      expect(created.payload.result).toBeUndefined();

      const duplicate = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-run' });
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
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-recover' });
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
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-first' });
      await until(api.origin, 'gate2-first', (snapshot) => snapshot.status === 'running');
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-second' });

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

  it('fails the run whose execution threw and keeps the lane serving the ones behind it', async () => {
    // A repository that throws where the caller expected a rejected promise: the `.catch()` guarding
    // that write never sees it, so it escapes `execute` and reaches the lane itself. Before the lane
    // was guarded, that left an unhandled rejection and every later run queued forever.
    const faulty = (repository: ProjectRepository): ProjectRepository => new Proxy(repository, {
      get(target, property, receiver) {
        if (property !== 'appendEvent') return Reflect.get(target, property, receiver) as unknown;
        return (event: Parameters<ProjectRepository['appendEvent']>[0]) => {
          if (event.type === 'prototype.run.started' && event.runId === 'gate2-doomed') throw new Error('o repositório recusou o evento de início');
          return target.appendEvent(event);
        };
      },
    }) as ProjectRepository;
    const api = await harness({ decorate: faulty });
    try {
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-doomed' });
      const failed = await settled(api.origin, 'gate2-doomed');
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('o repositório recusou o evento de início');

      // The lane is still a lane: the next run measures and settles behind the one that blew up.
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-after' });
      const next = await settled(api.origin, 'gate2-after');
      expect(next.status).toBe('settled');
      expect(next.result?.gate).toBe('needs_review');
    } finally { await api.close(); }
  });

  it('serves both sides of the comparison from the isolated preview origin', async () => {
    const api = await harness();
    try {
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-preview' });
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
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-decide' });
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
      await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-gate' });
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
      const first = new PrototypeRunRegistry({ repository, evidence: new DerivedEvidenceSource(), seed: createOffRhythmControlIR });
      await first.create('gate2-restart');
      let before = first.get('gate2-restart')!;
      for (let attempt = 0; attempt < 400 && (before.status === 'running' || before.status === 'queued'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        before = first.get('gate2-restart')!;
      }
      await first.decide('gate2-restart', { findingId: before.result!.issues[0]!.id, decision: 'accepted', rationale: 'Reparo causal aceito.' });

      // A run that never finished measuring when the process stopped.
      const stopped = new PrototypeRunRegistry({ repository, evidence: held.evidence });
      await stopped.create('gate2-interrupted');

      // A new process reads the same database and serves the review without measuring anything again.
      const restarted = new PrototypeRunRegistry({ repository, evidence: new DerivedEvidenceSource() });
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
      const registry = new PrototypeRunRegistry({ repository, evidence: new DerivedEvidenceSource(), seed: createOffRhythmControlIR });
      await registry.create('gate2-events');
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

describe('prototype registry provider recognition', () => {
  async function repository(): Promise<ProjectRepository> {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-gate2-provider-'));
    return new ProjectRepository(openDatabase(join(dir, 'gate2.sqlite')));
  }

  it('refuses a provider name it does not recognise instead of running the fakes', async () => {
    const repo = await repository();
    for (const name of ['Codex', 'codex ', 'claude', '']) {
      // `provider.ts` is the one place a name is recognised; a near miss is an
      // error here, not a silent deterministic run under the wrong alias.
      expect(() => new PrototypeRunRegistry({ repository: repo, evidence: new DerivedEvidenceSource(), modelProvider: name as never }))
        .toThrow(/Unknown model provider/);
    }
  });

  it('accepts every recognised name, and defaults to the fakes', async () => {
    const repo = await repository();
    for (const name of ['fake', 'claude-code', 'codex'] as const) {
      expect(() => new PrototypeRunRegistry({ repository: repo, evidence: new DerivedEvidenceSource(), modelProvider: name })).not.toThrow();
    }
    expect(() => new PrototypeRunRegistry({ repository: repo, evidence: new DerivedEvidenceSource() })).not.toThrow();
  });
});

