import { describe, expect, it } from 'vitest';
import { agentTaskSchema, createFixtureIR, hashJson, type AgentTask, type DesignIR } from '@pwb/domain';
import { FakeModelProvider } from '@pwb/providers';
import { Applier, PatchGate, RunPlanner, Scheduler, type GateVerdict, VersionStore } from './index.js';

const ALLOWED = ['/identity', '/pages', '/assets', '/reviewRecord'];

function task(id: string, baseVersionId = 'v0', overrides: Partial<AgentTask> = {}): AgentTask {
  return { id, attempt: 1, stage: 'identity', role: 'director', state: 'queued', lane: 'claude', baseVersionId, inputDigest: 'brief', promptVersion: '1', modelAlias: 'fake', deadlineMs: 1000, allowedPaths: ['/reviewRecord'], documentSlice: { '/identity': createFixtureIR().identity }, brief: 'fixture', ...overrides };
}

describe('orchestrator', () => {
  it('plans the fixed identity to prototype to finalization stage order', () => {
    const store = new VersionStore();
    const root = new Applier(store, new PatchGate()).createRoot(createFixtureIR());
    const plan = new RunPlanner(store).plan('run-1', root.id, 'brief');
    expect(plan.tasks.map((item) => item.stage)).toEqual(['identity', 'prototype', 'finalization']);
    expect(plan.tasks.map((item) => item.id)).toEqual(['task-identity', 'task-prototype', 'task-finalization']);
    expect(plan.edges).toEqual([['task-identity', 'task-prototype'], ['task-prototype', 'task-finalization']]);
  });

  it('hands every task an immutable slice of the base version and digests it', () => {
    const ir = createFixtureIR();
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const root = applier.createRoot(ir);
    const plan = new RunPlanner(store).plan('run-slice', root.id, 'brief');
    const identityTask = agentTaskSchema.parse(plan.tasks[0]);
    const prototypeTask = agentTaskSchema.parse(plan.tasks[1]);
    expect(identityTask.documentSlice['/identity']).toEqual(ir.identity);
    expect(prototypeTask.documentSlice['/identity']).toEqual(ir.identity);
    expect(prototypeTask.documentSlice['/pages']).toEqual(ir.pages);
    (identityTask.documentSlice['/pages'] as DesignIR['pages']).routes.length = 0;
    expect(store.get(root.id)!.ir.pages.routes).toHaveLength(3);
    const next = applier.apply({ operations: [{ op: 'replace', path: '/reviewRecord/findings', value: ['changed'] }], baseVersionId: root.id, touchedPaths: ['/reviewRecord/findings'], rationale: 'change the document', confidence: 1, stage: 'identity', role: 'director', idempotencyKey: 'slice-digest' }, ALLOWED, root.id);
    const replanned = new RunPlanner(store).plan('run-slice', next.id, 'brief');
    expect(replanned.tasks[0]!.documentSlice['/reviewRecord']).toEqual({ findings: ['changed'], approvals: [] });
    expect(replanned.tasks[0]!.inputDigest).not.toBe(identityTask.inputDigest);
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
    const valid = { operations: [{ op: 'replace' as const, path: '/reviewRecord/findings', value: ['one'] }], baseVersionId: 'v0', touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const, idempotencyKey: 'valid-key' };
    const decision = gate.validate(valid, context);
    expect(decision.ok).toBe(true);
    gate.commit('v0', decision);
    expect(() => gate.validate(valid, context)).toThrow(/overlap|idempotent/i);
    expect(() => gate.validate({ ...valid, idempotencyKey: 'different', baseVersionId: 'old' }, context)).toThrow(/stale/i);
    expect(() => gate.validate({ ...valid, idempotencyKey: undefined }, context)).toThrow(/idempotency key/i);
  });

  it('enforces allowed paths against the operations that actually write, not the declared paths', () => {
    const gate = new PatchGate();
    const context = { currentVersionId: 'v0', allowedPaths: ['/reviewRecord'] };
    const base = { baseVersionId: 'v0', touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const };
    expect(() => gate.validate({ ...base, idempotencyKey: 'a', operations: [{ op: 'replace' as const, path: '/identity/meta/status', value: 'approved' }] }, context)).toThrow(/not allowed/i);
    expect(() => gate.validate({ ...base, idempotencyKey: 'b', operations: [{ op: 'add' as const, path: '/__proto__/polluted', value: true }] }, context)).toThrow(/not allowed/i);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps the base version re-runnable when applying a patch fails', () => {
    const store = new VersionStore();
    const gate = new PatchGate();
    const applier = new Applier(store, gate);
    const root = applier.createRoot(createFixtureIR());
    const broken = { operations: [{ op: 'test' as const, path: '/reviewRecord/findings', value: ['never matches'] }, { op: 'replace' as const, path: '/reviewRecord/findings', value: ['one'] }], baseVersionId: root.id, touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const, idempotencyKey: 'retry-me' };
    expect(() => applier.apply(broken, ALLOWED, root.id)).toThrow(/test failed/i);
    const corrected = { ...broken, operations: [{ op: 'replace' as const, path: '/reviewRecord/findings', value: ['one'] }] };
    expect(applier.apply(corrected, ALLOWED, root.id).ir.reviewRecord.findings).toEqual(['one']);
  });

  it("compares a patch base against the run's current version, not against itself", () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const root = applier.createRoot(createFixtureIR());
    const first = applier.apply({ operations: [{ op: 'replace', path: '/reviewRecord/findings', value: ['first'] }], baseVersionId: root.id, touchedPaths: ['/reviewRecord/findings'], rationale: 'first', confidence: 1, stage: 'identity', role: 'director', idempotencyKey: 'first' }, ALLOWED, root.id);
    const stale = { operations: [{ op: 'replace' as const, path: '/reviewRecord/approvals', value: ['stale'] }], baseVersionId: root.id, touchedPaths: ['/reviewRecord/approvals'], rationale: 'stale', confidence: 1, stage: 'identity' as const, role: 'director' as const, idempotencyKey: 'stale' };
    expect(() => applier.apply(stale, ALLOWED, first.id)).toThrow(/stale patch base/i);
    expect(store.get(first.id)?.ir.reviewRecord.findings).toEqual(['first']);
    expect(store.get(root.id)?.ir.reviewRecord.findings).toEqual([]);
  });

  it('accepts a test operation whose value differs only in key order', () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const ir = createFixtureIR();
    const root = applier.createRoot(ir);
    const { source, author, license, date, hash } = ir.identity.provenance;
    const reordered = { hash, date, license, author, source };
    const patch = { operations: [{ op: 'test' as const, path: '/identity/provenance', value: reordered }, { op: 'replace' as const, path: '/reviewRecord/findings', value: ['ok'] }], baseVersionId: root.id, touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const, idempotencyKey: 'key-order' };
    expect(applier.apply(patch, ALLOWED, root.id).ir.reviewRecord.findings).toEqual(['ok']);
  });

  it('refuses a patch that writes outside the allowed paths of its task', () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const root = applier.createRoot(createFixtureIR());
    const patch = { operations: [{ op: 'replace' as const, path: '/identity/meta/status', value: 'draft' }], baseVersionId: root.id, touchedPaths: ['/identity/meta/status'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const, idempotencyKey: 'scoped' };
    expect(() => applier.apply(patch, ['/reviewRecord'], root.id)).toThrow(/not allowed/i);
    expect(applier.apply(patch, ['/identity'], root.id).ir.identity.meta.status).toBe('draft');
  });

  it('inserts array elements on add instead of overwriting them', () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const root = applier.createRoot(createFixtureIR());
    const patch = { operations: [{ op: 'add' as const, path: '/reviewRecord/findings/0', value: 'first' }, { op: 'add' as const, path: '/reviewRecord/findings/-', value: 'last' }], baseVersionId: root.id, touchedPaths: ['/reviewRecord/findings'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const, idempotencyKey: 'array-add' };
    const next = applier.apply(patch, ALLOWED, root.id);
    expect(next.ir.reviewRecord.findings).toEqual(['first', 'last']);
  });

  it('reports the paths the operations actually wrote, not the ones the agent declared', () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const root = applier.createRoot(createFixtureIR());
    const patch = { operations: [{ op: 'test' as const, path: '/reviewRecord/findings', value: [] }, { op: 'replace' as const, path: '/identity/meta/status', value: 'draft' as const }, { op: 'add' as const, path: '/reviewRecord/findings/-', value: 'noted' }], baseVersionId: root.id, touchedPaths: ['/reviewRecord'], rationale: 'test', confidence: 1, stage: 'identity' as const, role: 'director' as const, idempotencyKey: 'diff-paths' };
    expect(applier.dryRun(patch, ALLOWED, root.id).diff).toEqual(['/identity/meta/status', '/reviewRecord/findings/0']);
  });

  it('reopens a rejected base so the next attempt can propose against it again', () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const root = applier.createRoot(createFixtureIR());
    const patch = { operations: [{ op: 'replace' as const, path: '/reviewRecord/findings', value: ['first try'] }], baseVersionId: root.id, touchedPaths: ['/reviewRecord/findings'], rationale: 'first try', confidence: 1, stage: 'identity' as const, role: 'director' as const, idempotencyKey: 'first-try' };
    const rejected = applier.apply(patch, ALLOWED, root.id);
    expect(() => applier.apply(patch, ALLOWED, root.id)).toThrow(/idempotent|overlap/i);
    expect(applier.rewind(rejected)?.id).toBe(root.id);
    expect(applier.apply(patch, ALLOWED, root.id).id).toBe(rejected.id);
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

  it('starts a stage only after the stage it depends on has succeeded', async () => {
    const store = new VersionStore();
    const root = new Applier(store, new PatchGate()).createRoot(createFixtureIR());
    const plan = new RunPlanner(store).plan('run-dag', root.id, 'brief');
    const started: string[] = [];
    const finished: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const result = await new Scheduler({ maxActiveClaude: 3 }).run(plan.tasks, async (item) => {
      started.push(item.id);
      concurrent += 1; peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished.push(item.id);
      concurrent -= 1;
      return item.stage;
    }, { edges: plan.edges });
    expect(peak).toBe(1);
    expect(finished).toEqual(['task-identity', 'task-prototype', 'task-finalization']);
    for (const [dependency, dependent] of plan.edges) {
      expect(started.indexOf(dependent)).toBeGreaterThan(finished.indexOf(dependency));
    }
    expect(result.results.map((item) => item.state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  });

  it('cancels the stages that depend on a stage which did not succeed', async () => {
    const store = new VersionStore();
    const root = new Applier(store, new PatchGate()).createRoot(createFixtureIR());
    const plan = new RunPlanner(store).plan('run-dag', root.id, 'brief');
    const result = await new Scheduler().run(plan.tasks, async (item) => {
      if (item.stage === 'identity') throw new Error('director failed');
      return item.stage;
    }, { edges: plan.edges });
    expect(result.results.map((item) => [item.task.id, item.state])).toEqual([
      ['task-identity', 'failed'],
      ['task-prototype', 'cancelled'],
      ['task-finalization', 'cancelled'],
    ]);
  });

  it('holds a dependent stage until its predecessor gate is settled and re-runs a rejected stage', async () => {
    const store = new VersionStore();
    const root = new Applier(store, new PatchGate()).createRoot(createFixtureIR());
    const plan = new RunPlanner(store).plan('run-gate', root.id, 'brief');
    const started: string[] = [];
    const approved = new Set<string>();
    let identityVerdicts: GateVerdict[] = ['rejected', 'approved'];
    const result = await new Scheduler().run(plan.tasks, async (item) => { started.push(`${item.id}#${item.attempt}`); return item.stage; }, {
      edges: plan.edges,
      settle: async (item) => {
        const verdict = item.id === 'task-identity' ? identityVerdicts.shift()! : 'approved';
        if (verdict === 'approved') approved.add(item.id);
        return verdict;
      },
    });
    expect(started).toEqual(['task-identity#1', 'task-identity#2', 'task-prototype#1', 'task-finalization#1']);
    expect(result.results.map((item) => [item.task.id, item.task.attempt, item.state])).toEqual([
      ['task-identity', 2, 'succeeded'],
      ['task-prototype', 1, 'succeeded'],
      ['task-finalization', 1, 'succeeded'],
    ]);
  });

  it('refuses a stage submitted on its own until its predecessor is in the completed set', async () => {
    const store = new VersionStore();
    const root = new Applier(store, new PatchGate()).createRoot(createFixtureIR());
    const plan = new RunPlanner(store).plan('run-completed', root.id, 'brief');
    const prototype = plan.tasks.filter((item) => item.id === 'task-prototype');
    const started: string[] = [];
    const worker = async (item: AgentTask): Promise<string> => { started.push(item.id); return item.stage; };
    const blocked = await new Scheduler().run(prototype, worker, { edges: plan.edges });
    expect(started).toEqual([]);
    expect(blocked.results.map((item) => [item.task.id, item.state])).toEqual([['task-prototype', 'failed']]);
    expect((blocked.results[0]!.error as Error).message).toMatch(/task-identity/);
    const admitted = await new Scheduler().run(prototype, worker, { edges: plan.edges, completed: ['task-identity'] });
    expect(started).toEqual(['task-prototype']);
    expect(admitted.results.map((item) => [item.task.id, item.state])).toEqual([['task-prototype', 'succeeded']]);
  });

  it('creates immutable versions and preserves the parent on cancel/restart', async () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const root = applier.createRoot(createFixtureIR());
    const provider = new FakeModelProvider();
    const proposal = (await provider.propose(task('agent-1', root.id))).proposal!;
    const dry = applier.dryRun(proposal, ALLOWED, root.id);
    expect(dry.versionId).toBe(root.id);
    expect(store.get(root.id)?.ir.reviewRecord.findings).toEqual([]);
    const next = applier.apply(proposal, ALLOWED, root.id);
    expect(next.parentId).toBe(root.id);
    expect(next.id).not.toBe(root.id);
    expect(next.hash).toBe(hashJson(next.ir));
    expect(store.get(root.id)?.hash).toBe(root.hash);
  });
});
