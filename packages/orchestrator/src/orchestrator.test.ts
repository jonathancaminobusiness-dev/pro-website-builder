import { describe, expect, it } from 'vitest';
import { createFixtureIR, type AgentTask } from '@pwb/domain';
import { FakeModelProvider } from '@pwb/providers';
import { Applier, PatchGate, RunPlanner, Scheduler, VersionStore } from './index.js';

function task(id: string, baseVersionId = 'v0'): AgentTask {
  return { id, stage: 'identity', role: 'director', state: 'queued', baseVersionId, inputDigest: 'brief', promptVersion: '1', modelAlias: 'fake', deadlineMs: 1000, allowedPaths: ['/reviewRecord'], brief: 'fixture' };
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
    const valid = { op: 'proposal' as const, operations: [{ op: 'replace' as const, path: '/reviewRecord/findings', value: ['one'] }], baseVersionId: 'v0', touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const };
    expect(gate.validate(valid, { currentVersionId: 'v0', allowedPaths: ['/reviewRecord'] }).ok).toBe(true);
    expect(() => gate.validate(valid, { currentVersionId: 'v0', allowedPaths: ['/reviewRecord'] })).toThrow(/overlap|idempotent/i);
    expect(() => gate.validate({ ...valid, idempotencyKey: 'different', baseVersionId: 'old' }, { currentVersionId: 'v0', allowedPaths: ['/reviewRecord'] })).toThrow(/stale/i);
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
    expect(store.get(root.id)?.hash).toBe(root.hash);
    expect(next.inverse.operations[0]?.op).toBe('replace');
  });
});
