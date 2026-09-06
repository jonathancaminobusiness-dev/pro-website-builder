import { describe, expect, it } from 'vitest';
import { createFixtureIR, hashJson, type AgentTask } from '@pwb/domain';
import { FakeModelProvider } from '@pwb/providers';
import { Applier, PatchGate, RunPlanner, Scheduler, VersionStore } from './index.js';

function task(id: string, baseVersionId = 'v0', overrides: Partial<AgentTask> = {}): AgentTask {
  return { id, stage: 'identity', role: 'director', state: 'queued', lane: 'claude', baseVersionId, inputDigest: 'brief', promptVersion: '1', modelAlias: 'fake', deadlineMs: 1000, allowedPaths: ['/reviewRecord'], brief: 'fixture', ...overrides };
}

describe('orchestrator', () => {
  it('creates the fixed identity to prototype to finalization DAG', () => {
    const plan = new RunPlanner().plan('run-1', 'v0', 'brief');
    expect(plan.tasks.map((item) => item.stage)).toEqual(['identity', 'prototype', 'finalization']);
    expect(plan.edges).toEqual([['task-identity', 'task-prototype'], ['task-prototype', 'task-finalization']]);
  });

  it('enforces the configured concurrent task limit', async () => {
    const scheduler = new Scheduler({ maxActiveClaude: 2, maxActiveRaster: 1 });
    let active = 0;
    let peak = 0;
    const result = await scheduler.run([task('a'), task('b'), task('c')], async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return 'ok';
    });
    expect(result.results).toHaveLength(3);
    expect(peak).toBe(2);
  });

  it('rejects stale and overlapping patches before the applier mutates a version', () => {
    const gate = new PatchGate();
    const context = { currentVersionId: 'v0', allowedPaths: ['/reviewRecord'] };
    const valid = { op: 'proposal' as const, operations: [{ op: 'replace' as const, path: '/reviewRecord/findings', value: ['one'] }], baseVersionId: 'v0', touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const };
    const decision = gate.validate(valid, context);
    expect(decision.ok).toBe(true);
    gate.commit('v0', decision);
    expect(() => gate.validate(valid, context)).toThrow(/overlap|idempotent/i);
    expect(() => gate.validate({ ...valid, idempotencyKey: 'different', baseVersionId: 'old' }, context)).toThrow(/stale/i);
  });

  it('enforces allowed paths against the operations that actually write, not the declared paths', () => {
    const gate = new PatchGate();
    const context = { currentVersionId: 'v0', allowedPaths: ['/reviewRecord'] };
    const base = { op: 'proposal' as const, baseVersionId: 'v0', touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const };
    expect(() => gate.validate({ ...base, idempotencyKey: 'a', operations: [{ op: 'replace' as const, path: '/identity/meta/status', value: 'approved' }] }, context)).toThrow(/not allowed/i);
    expect(() => gate.validate({ ...base, idempotencyKey: 'b', operations: [{ op: 'add' as const, path: '/__proto__/polluted', value: true }] }, context)).toThrow(/not allowed/i);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps the base version re-runnable when applying a patch fails', () => {
    const store = new VersionStore();
    const gate = new PatchGate();
    const applier = new Applier(store, gate);
    const root = applier.createRoot(createFixtureIR());
    const broken = { op: 'proposal' as const, operations: [{ op: 'test' as const, path: '/reviewRecord/findings', value: ['never matches'] }, { op: 'replace' as const, path: '/reviewRecord/findings', value: ['one'] }], baseVersionId: root.id, touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const, idempotencyKey: 'retry-me' };
    expect(() => applier.apply(broken)).toThrow(/test failed/i);
    const corrected = { ...broken, operations: [{ op: 'replace' as const, path: '/reviewRecord/findings', value: ['one'] }] };
    expect(applier.apply(corrected).ir.reviewRecord.findings).toEqual(['one']);
  });

  it('inserts array elements on add instead of overwriting them', () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const root = applier.createRoot(createFixtureIR());
    const patch = { op: 'proposal' as const, operations: [{ op: 'add' as const, path: '/reviewRecord/findings/0', value: 'first' }, { op: 'add' as const, path: '/reviewRecord/findings/-', value: 'last' }], baseVersionId: root.id, touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const };
    const next = applier.apply(patch);
    expect(next.ir.reviewRecord.findings).toEqual(['first', 'last']);
    expect(next.inverse.operations.map((operation) => operation.path)).toEqual(['/reviewRecord/findings/1', '/reviewRecord/findings/0']);
  });

  it('keeps raster jobs on their own semaphore while Claude tasks run in parallel', async () => {
    const scheduler = new Scheduler({ maxActiveClaude: 3, maxActiveRaster: 1 });
    const active = { claude: 0, raster: 0 };
    const peak = { claude: 0, raster: 0 };
    const tasks = [task('c1'), task('c2'), task('c3'), task('r1', 'v0', { lane: 'raster' }), task('r2', 'v0', { lane: 'raster' }), task('r3', 'v0', { lane: 'raster' })];
    await scheduler.run(tasks, async (item) => {
      const lane = item.lane;
      active[lane] += 1; peak[lane] = Math.max(peak[lane], active[lane]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active[lane] -= 1;
      return 'ok';
    });
    expect(peak.claude).toBe(3);
    expect(peak.raster).toBe(1);
  });

  it('fails a task that outlives its deadline and aborts its signal', async () => {
    const scheduler = new Scheduler({ maxActiveClaude: 1 });
    let aborted = false;
    const result = await scheduler.run([task('slow', 'v0', { deadlineMs: 20 })], (_, signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }));
    expect(result.results[0]?.state).toBe('failed');
    expect((result.results[0]?.error as Error).message).toMatch(/deadline/i);
    expect(aborted).toBe(true);
    expect(result.cancelled).toBe(false);
  });

  it('creates immutable versions and preserves the parent on cancel/restart', async () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const root = applier.createRoot(createFixtureIR());
    const provider = new FakeModelProvider();
    const proposal = (await provider.propose(task('agent-1', root.id))).proposal!;
    const dry = applier.dryRun(proposal);
    expect(dry.versionId).toBe(root.id);
    expect(store.get(root.id)?.ir.reviewRecord.findings).toEqual([]);
    const next = applier.apply(proposal);
    expect(next.parentId).toBe(root.id);
    expect(next.id).not.toBe(root.id);
    expect(next.hash).toBe(hashJson(next.ir));
    expect(store.get(root.id)?.hash).toBe(root.hash);
    expect(next.inverse.operations[0]?.op).toBe('replace');
  });
});
