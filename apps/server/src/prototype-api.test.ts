import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, type DesignIR } from '@pwb/domain';
import { FakeModelProvider } from '@pwb/providers';
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

async function harness(options: { seed?: () => DesignIR } = {}): Promise<{ origin: string; registry: PrototypeRunRegistry; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pwb-gate2-'));
  const db = openDatabase(join(dir, 'gate2.sqlite'));
  const repository = new ProjectRepository(db);
  const registry = new PrototypeRunRegistry({ repository, ...(options.seed ? { seed: options.seed } : {}) });
  const runs = new Map<string, FixtureRun>();
  const server = createApiServer({
    runs, prototypes: registry,
    createRun: async (id) => { const run = new FixtureRun({ repository, exportRoot: join(dir, 'exports'), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; },
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

describe('Gate 2 API', () => {
  it('starts a prototype run only for the captain and returns everything the gate screen compares', async () => {
    const api = await harness();
    try {
      const refused = await post(api.origin, '/api/prototype/runs', { runId: 'gate2-run' });
      expect(refused.status).toBe(403);
      expect(refused.payload.error).toContain('Only the captain');

      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-run' });
      expect(created.status).toBe(201);
      const snapshot = created.payload;
      expect(snapshot.routes.map((route) => route.route)).toEqual(['/', '/proof', '/contact']);
      expect(snapshot.viewports).toEqual([320, 360, 390, 768, 1024, 1440]);
      expect(snapshot.states).toEqual(['default', 'empty', 'error', 'focus', 'loading', 'reduced']);
      expect(snapshot.gate).toBe('needs_review');
      expect(snapshot.qa.filter((check) => check.severity === 'veto')).toEqual([]);
      expect(snapshot.reports).toHaveLength(4);
      expect(snapshot.before.versionId).toMatch(/^v-/);
      expect(snapshot.cycles.length).toBeGreaterThan(0);

      const duplicate = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-run' });
      expect(duplicate.status).toBe(409);

      const fetched = await fetch(`${api.origin}/api/prototype/runs/gate2-run`);
      expect((await fetched.json() as Gate2Snapshot).runId).toBe('gate2-run');
      expect((await fetch(`${api.origin}/api/prototype/runs/absent`)).status).toBe(404);
    } finally { await api.close(); }
  });

  it('serves both sides of the comparison from the isolated preview origin', async () => {
    const api = await harness();
    try {
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-preview' });
      for (const versionId of [created.payload.before.versionId, created.payload.after.versionId]) {
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
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-decide' });
      const findingId = created.payload.issues[0]!.id;
      const path = '/api/prototype/runs/gate2-decide/decision';

      expect((await post(api.origin, path, { approverRole: 'captain', findingId, decision: 'accepted', rationale: '  ' })).status).toBe(400);
      expect((await post(api.origin, path, { approverRole: 'designer', findingId, decision: 'accepted', rationale: 'ok' })).status).toBe(403);
      expect((await post(api.origin, path, { approverRole: 'captain', findingId: 'ghost-finding', decision: 'accepted', rationale: 'ok' })).status).toBe(400);
      expect((await post(api.origin, path, { approverRole: 'captain', findingId, decision: 'maybe', rationale: 'ok' })).status).toBe(400);

      const decided = await post(api.origin, path, { approverRole: 'captain', findingId, decision: 'deferred', rationale: 'Sem tempo de revisar agora.' });
      expect(decided.payload.decisions).toHaveLength(1);
      expect(decided.payload.decisions[0]).toMatchObject({ findingId, decision: 'deferred', rationale: 'Sem tempo de revisar agora.', reviewerRole: 'captain' });
    } finally { await api.close(); }
  });

  it('records the gate decision against the reviewed revision and keeps it captain-only', async () => {
    const api = await harness();
    try {
      const created = await post(api.origin, '/api/prototype/runs', { approverRole: 'captain', runId: 'gate2-gate' });
      const path = '/api/prototype/runs/gate2-gate/gate';
      expect((await post(api.origin, path, { approverRole: 'captain', decision: 'maybe', rationale: 'ok' })).status).toBe(400);
      expect((await post(api.origin, path, { approverRole: 'designer', decision: 'approved', rationale: 'ok' })).status).toBe(403);

      const approved = await post(api.origin, path, { approverRole: 'captain', decision: 'approved', rationale: 'Hierarquia e caráter aprovados.' });
      expect(approved.status).toBe(200);
      expect(approved.payload.approval).toMatchObject({ decision: 'approved', versionId: created.payload.after.versionId, approverRole: 'captain', stage: 'prototype' });
    } finally { await api.close(); }
  });

  it('writes the gate history to the event log without leaking a credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-gate2-events-'));
    const db = openDatabase(join(dir, 'events.sqlite'));
    const repository = new ProjectRepository(db);
    try {
      const registry = new PrototypeRunRegistry({ repository, seed: createOffRhythmControlIR });
      const snapshot = await registry.create('gate2-events');
      await registry.decide('gate2-events', { findingId: snapshot.issues[0]!.id, decision: 'accepted', rationale: 'Reparo causal aceito.' });
      await registry.settle('gate2-events', { decision: 'approved', rationale: 'Aprovado.' });
      const types = (await repository.listEvents('gate2-events')).map((event) => event.type);
      expect(types).toContain('prototype.qa.gate');
      expect(types).toContain('prototype.stage.settled');
      expect(types).toContain('gate2.decided');
      expect(repository.dump()).not.toMatch(/(api[_-]?key|password|secret)["']?\s*[:=]/i);
    } finally { db.sqlite.close(); }
  });
});
