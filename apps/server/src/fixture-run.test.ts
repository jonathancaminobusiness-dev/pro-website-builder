import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { FakeModelProvider, type ModelProvider } from '@pwb/providers';
import { openDatabase, ProjectRepository, type LocalDatabase } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';

describe('phase 0 fixture run', () => {
  it('crosses all three captain gates and exports three routes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-run-'));
    const db = openDatabase(join(dir, 'run.sqlite'));
    const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(dir, 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-1');
    const snapshot = await run.runAll();
    expect(snapshot.status).toBe('succeeded');
    expect(snapshot.approvals).toHaveLength(3);
    expect(snapshot.exportManifest?.routes).toEqual(['/', '/proof', '/contact']);
    expect((await readdir(snapshot.exportManifest!.directory)).sort()).toEqual(['contact', 'index.html', 'manifest.json', 'proof']);
    db.sqlite.close();
  });

  it('writes an append-only event log for the whole journey', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const run = new FixtureRun({ repository, exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-events-')), 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-events');
    await run.runAll();
    const events = await repository.listEvents('run-events');
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['run.created', 'run.started', 'task.queued', 'task.started', 'task.succeeded', 'patch.applied', 'version.created', 'approval.recorded', 'run.finished']));
    expect(events.at(-1)?.type).toBe('run.finished');
    expect(events.filter((event) => event.type === 'approval.recorded')).toHaveLength(3);
    db.sqlite.close();
  });

  it('lets the captain re-run a stage that was rejected', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const run = new FixtureRun({ repository, exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-reject-')), 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-reject');
    await run.runNext();
    const rejected = await run.reject('identity', 'captain');
    expect(rejected.status).toBe('rejected');
    expect(rejected.approvals.at(-1)?.decision).toBe('rejected');
    const rerun = await run.runNext();
    expect(rerun.status).toBe('needs_review');
    expect(rerun.currentStage).toBe('identity');
    expect(rerun.currentVersion.id).not.toBe(rejected.currentVersion.id);
    const tasks = (JSON.parse(repository.dump()) as { tasks: Array<{ id: string; stage: string; base_version_id: string }> }).tasks;
    const identityTasks = tasks.filter((task) => task.stage === 'identity');
    expect(identityTasks).toHaveLength(2);
    expect(identityTasks.map((task) => task.base_version_id)).toEqual([rejected.currentVersion.id, rejected.currentVersion.id]);
    expect((await run.runAll()).status).toBe('succeeded');
    db.sqlite.close();
  });

  it('holds the prototype stage until the captain approves identity, across a rejected re-run', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const fake = new FakeModelProvider();
    const attempted: string[] = [];
    const recording: ModelProvider = { async propose(task, signal) { attempted.push(`${task.stage}#${task.attempt}`); return fake.propose(task, signal); } };
    const run = new FixtureRun({ repository, exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-order-')), 'exports'), provider: recording });
    await run.initialize('run-order');
    expect((await run.runNext()).currentStage).toBe('identity');
    expect(attempted).toEqual(['identity#1']);
    await run.reject('identity', 'captain');
    expect((await run.runNext()).currentStage).toBe('identity');
    expect(attempted).toEqual(['identity#1', 'identity#2']);
    await run.approve('identity', 'captain');
    expect((await run.runNext()).currentStage).toBe('prototype');
    expect(attempted).toEqual(['identity#1', 'identity#2', 'prototype#1']);
    const events = (await repository.listEvents('run-order')).map((event) => event.type);
    expect(events.indexOf('approval.recorded')).toBeLessThan(events.lastIndexOf('task.started'));
    db.sqlite.close();
  });

  it('records the finalization approval only after the export succeeds', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const blocked = join(await mkdtemp(join(tmpdir(), 'pwb-license-')), 'not-a-directory');
    await writeFile(blocked, 'the export root cannot be created under a regular file', 'utf8');
    const run = new FixtureRun({ repository, exportRoot: join(blocked, 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-license');
    await run.runNext();
    await run.approve('identity', 'captain');
    await run.runNext();
    await run.approve('prototype', 'captain');
    expect((await run.runNext()).currentStage).toBe('finalization');
    await expect(run.approve('finalization', 'captain')).rejects.toThrow(/ENOTDIR|not a directory/i);
    await expect(run.approve('finalization', 'captain')).rejects.toThrow(/ENOTDIR|not a directory/i);
    expect(run.snapshot().approvals.filter((entry) => entry.stage === 'finalization')).toHaveLength(0);
    expect(run.snapshot().status).toBe('needs_review');
    const recorded = (await repository.listEvents('run-license')).filter((event) => event.type === 'approval.recorded' && event.payload.stage === 'finalization');
    expect(recorded).toHaveLength(0);
    db.sqlite.close();
  });

  it('refuses a second gate decision that races the first one', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const run = new FixtureRun({ repository, exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-race-gate-')), 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-race-gate');
    await run.runNext();
    await run.approve('identity', 'captain');
    const approvedIdentity = run.snapshot().currentVersion.id;
    await run.runNext();
    const atGate = run.snapshot().currentVersion.id;
    const [first, second] = await Promise.allSettled([run.reject('prototype', 'captain'), run.reject('prototype', 'captain')]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    const rewound = run.snapshot();
    expect(rewound.currentVersion.id).toBe(approvedIdentity);
    expect(rewound.currentVersion.id).not.toBe(atGate);
    expect(rewound.approvals.filter((entry) => entry.decision === 'rejected')).toHaveLength(1);
    expect((await run.runNext()).currentStage).toBe('prototype');
    db.sqlite.close();
  });

  it('refuses a second approval that races the first one', async () => {
    const db = openDatabase(':memory:');
    const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-race-approve-')), 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-race-approve');
    await run.runNext();
    const [first, second] = await Promise.allSettled([run.approve('identity', 'captain'), run.approve('identity', 'captain')]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(run.snapshot().approvals).toHaveLength(1);
    expect((await run.runNext()).currentStage).toBe('prototype');
    db.sqlite.close();
  });

  it('drops a rejected proposal from the document the re-run starts from', async () => {
    const db = openDatabase(':memory:');
    const proposer: ModelProvider = {
      async propose(task) {
        const name = task.attempt === 1 ? 'rejected' : 'kept';
        return { taskId: task.id, status: 'succeeded', summary: `Add ${name}`, proposal: { operations: [{ op: 'add', path: `/identity/tokens/color/${name}`, value: { $value: '#123456', $type: 'color' } }], baseVersionId: task.baseVersionId, touchedPaths: [`/identity/tokens/color/${name}`], rationale: `Add the ${name} token`, confidence: 1, stage: task.stage, role: task.role, idempotencyKey: 'identity-token' } };
      },
    };
    const repository = new ProjectRepository(db);
    const run = new FixtureRun({ repository, exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-rewind-')), 'exports'), provider: proposer });
    await run.initialize('run-rewind');
    const rootId = run.snapshot().currentVersion.id;
    const proposed = await run.runNext();
    expect(proposed.currentVersion.ir.identity.tokens.color).toHaveProperty('rejected');
    const rejected = await run.reject('identity', 'captain');
    expect(rejected.currentVersion.id).toBe(rootId);
    expect(rejected.currentVersion.ir.identity.tokens.color).not.toHaveProperty('rejected');
    const rerun = await run.runNext();
    expect(rerun.currentStage).toBe('identity');
    expect(rerun.currentVersion.ir.identity.tokens.color).toHaveProperty('kept');
    expect(rerun.currentVersion.ir.identity.tokens.color).not.toHaveProperty('rejected');
    const patches = (JSON.parse(repository.dump()) as { patches: Array<{ payload: string }> }).patches;
    expect(patches.map((row) => (JSON.parse(row.payload) as { operations: Array<{ path: string }> }).operations[0]!.path)).toContain('/identity/tokens/color/kept');
    db.sqlite.close();
  });

  it('spends no model call on approval alone and exactly one on the next start request', async () => {
    const db = openDatabase(':memory:');
    const fake = new FakeModelProvider();
    const attempted: string[] = [];
    const recording: ModelProvider = { async propose(task, signal) { attempted.push(`${task.stage}#${task.attempt}`); return fake.propose(task, signal); } };
    const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-start-')), 'exports'), provider: recording });
    await run.initialize('run-start');
    await run.runNext();
    expect(attempted).toEqual(['identity#1']);
    await run.approve('identity', 'captain');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(attempted).toEqual(['identity#1']);
    expect((await run.runNext()).currentStage).toBe('prototype');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(attempted).toEqual(['identity#1', 'prototype#1']);
    db.sqlite.close();
  });

  it('records a terminal event for a stage whose worker throws, and does not replay it on the next attempt', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const fake = new FakeModelProvider();
    let failOnce = true;
    const flaky: ModelProvider = { async propose(task, signal) { if (failOnce) { failOnce = false; throw new Error('the model process died'); } return fake.propose(task, signal); } };
    const run = new FixtureRun({ repository, exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-throw-')), 'exports'), provider: flaky });
    await run.initialize('run-throw');
    await expect(run.runNext()).rejects.toThrow(/the model process died/);
    const afterFailure = (await repository.listEvents('run-throw')).map((event) => event.type);
    expect(afterFailure.at(-1)).toBe('task.failed');
    expect(run.snapshot().status).toBe('failed');
    const recovered = await run.runNext();
    expect(recovered.status).toBe('needs_review');
    expect(recovered.currentStage).toBe('identity');
    const tasks = (JSON.parse(repository.dump()) as { tasks: Array<{ stage: string; attempt: number }> }).tasks;
    expect(tasks.filter((task) => task.stage === 'identity').map((task) => task.attempt).sort()).toEqual([1, 2]);
    db.sqlite.close();
  });

  it('keeps a pending captain gate across cancel and restart', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const run = new FixtureRun({ repository, exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-restart-')), 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-restart');
    const pending = await run.runNext();
    expect(pending.status).toBe('needs_review');
    await run.cancel();
    expect(run.snapshot().status).toBe('cancelled');
    const restarted = await run.restart();
    expect(restarted.status).toBe('needs_review');
    expect(restarted.currentStage).toBe('identity');
    expect(restarted.currentVersion.id).toBe(pending.currentVersion.id);
    expect((await repository.listEvents('run-restart')).map((event) => event.type)).toContain('run.restarted');
    expect((await run.approve('identity', 'captain')).approvals).toHaveLength(1);
    db.sqlite.close();
  });

  it('honours a cancel that lands while the stage is being persisted', async () => {
    const db = openDatabase(':memory:');
    class CancellingRepository extends ProjectRepository {
      constructor(database: LocalDatabase, private readonly beforeSave: () => Promise<unknown>) { super(database); }
      override async savePatch(patch: Parameters<ProjectRepository['savePatch']>[0], runId: string): Promise<void> {
        await this.beforeSave();
        await super.savePatch(patch, runId);
      }
    }
    let run!: FixtureRun;
    let cancelOnce = true;
    const repository = new CancellingRepository(db, async () => { if (!cancelOnce) return; cancelOnce = false; await run.cancel(); });
    run = new FixtureRun({ repository, exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-race-')), 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-race');
    const raced = await run.runNext();
    expect(raced.status).toBe('cancelled');
    const restarted = await run.restart();
    expect(restarted.status).toBe('needs_review');
    expect(restarted.currentStage).toBe('identity');
    expect((await run.approve('identity', 'captain')).approvals).toHaveLength(1);
    const nextStage = await run.runNext();
    expect(nextStage.status).toBe('needs_review');
    expect(nextStage.currentStage).toBe('prototype');
    db.sqlite.close();
  });

  it('aborts the signal the in-flight stage worker holds when the captain cancels', async () => {
    const db = openDatabase(':memory:');
    let run!: FixtureRun;
    let abortedWhileRunning = false;
    const watcher: ModelProvider = {
      async propose(task, signal) {
        await run.cancel();
        abortedWhileRunning = signal?.aborted ?? false;
        return { taskId: task.id, status: 'failed', summary: 'The captain cancelled the stage.' };
      },
    };
    run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-abort-')), 'exports'), provider: watcher });
    await run.initialize('run-abort');
    const cancelled = await run.runNext();
    expect(abortedWhileRunning).toBe(true);
    expect(cancelled.status).toBe('cancelled');
    expect((await run.restart()).status).toBe('queued');
    db.sqlite.close();
  });

  it('never commits a token rename that the identity contract no longer resolves', async () => {
    const db = openDatabase(':memory:');
    const renamer: ModelProvider = {
      async propose(task) {
        return { taskId: task.id, status: 'succeeded', summary: 'Rename a token', proposal: { operations: [{ op: 'remove', path: '/identity/tokens/color/ink' }], baseVersionId: task.baseVersionId, touchedPaths: ['/identity/tokens/color/ink'], rationale: 'Rename the ink token', confidence: 1, stage: task.stage, role: task.role, idempotencyKey: `rename-${task.stage}` } };
      },
    };
    const repository = new ProjectRepository(db);
    const run = new FixtureRun({ repository, exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-rename-')), 'exports'), provider: renamer });
    await run.initialize('run-rename');
    const before = run.snapshot();
    await expect(run.runNext()).rejects.toThrow(/color\.ink/);
    const events = await repository.listEvents('run-rename');
    expect(events.at(-1)?.type).toBe('task.failed');
    expect(String(events.at(-1)?.payload.reason)).toMatch(/color\.ink/);
    const after = run.snapshot();
    expect(after.currentVersion.id).toBe(before.currentVersion.id);
    expect(after.rendered).toEqual(before.rendered);
    expect(after.status).toBe('queued');
    db.sqlite.close();
  });

  it('cancels before apply and restarts from the same immutable revision', async () => {
    const db = openDatabase(':memory:');
    const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: '/tmp/pwb-fixture-test', provider: new FakeModelProvider() });
    await run.initialize('run-2');
    const rootId = run.snapshot().currentVersion.id;
    await run.cancel();
    expect(run.snapshot().status).toBe('cancelled');
    expect(run.snapshot().currentVersion.id).toBe(rootId);
    await run.restart();
    expect((await run.runAll()).status).toBe('succeeded');
    db.sqlite.close();
  });

  it('refuses to approve a version that carries lint errors', async () => {
    const db = openDatabase(':memory:');
    const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-lint-')), 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-lint');
    await run.runNext();
    const dirty = structuredClone((run as unknown as { currentVersion: { ir: ReturnType<typeof createFixtureIR> } }).currentVersion.ir);
    dirty.identity.forbiddenDefaults.fonts = [...dirty.identity.forbiddenDefaults.fonts, String((dirty.identity.tokens as { type: { body: { $value: string } } }).type.body.$value)];
    (run as unknown as { currentVersion: { ir: unknown } }).currentVersion.ir = dirty;
    await expect(run.approve('identity', 'captain')).rejects.toThrow(/lint error/i);
    expect(run.snapshot().approvals).toHaveLength(0);
    db.sqlite.close();
  });

  it('keeps the gate reviewable when the approval cannot be persisted', async () => {
    const db = openDatabase(':memory:');
    class FailingRepository extends ProjectRepository {
      override async createApproval(): Promise<void> { throw new Error('disk is full'); }
    }
    const run = new FixtureRun({ repository: new FailingRepository(db), exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-approve-')), 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-approve-fail');
    await run.runNext();
    await expect(run.approve('identity', 'captain')).rejects.toThrow(/disk is full/);
    const after = run.snapshot();
    expect(after.status).toBe('needs_review');
    expect(after.currentStage).toBe('identity');
    expect(after.approvals).toHaveLength(0);
    db.sqlite.close();
  });

  it('restores a persisted run so a restarted process can serve and continue it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-restore-'));
    const dbPath = join(dir, 'restore.sqlite');
    const first = openDatabase(dbPath);
    const original = new FixtureRun({ repository: new ProjectRepository(first), exportRoot: join(dir, 'exports'), provider: new FakeModelProvider() });
    await original.initialize('run-restore');
    await original.runNext();
    await original.approve('identity', 'captain');
    const before = original.snapshot();
    first.sqlite.close();

    const second = openDatabase(dbPath);
    const restored = new FixtureRun({ repository: new ProjectRepository(second), exportRoot: join(dir, 'exports'), provider: new FakeModelProvider() });
    expect(await restored.restore('run-restore')).toBe(true);
    const after = restored.snapshot();
    expect(after.currentVersion.id).toBe(before.currentVersion.id);
    expect(after.rendered.routes[0]!.html).toBe(before.rendered.routes[0]!.html);
    expect(after.approvals).toHaveLength(1);
    const next = await restored.runNext();
    expect(next.currentStage).toBe('prototype');
    expect(await restored.restore('absent-run')).toBe(false);
    second.sqlite.close();
  });

  it('discards an ungated proposal when the process restarts before the captain decides', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-restore-pending-'));
    const dbPath = join(dir, 'pending.sqlite');
    const first = openDatabase(dbPath);
    const original = new FixtureRun({ repository: new ProjectRepository(first), exportRoot: join(dir, 'exports'), provider: new FakeModelProvider() });
    await original.initialize('run-pending');
    const root = original.snapshot().currentVersion;
    const pending = await original.runNext();
    expect(pending.status).toBe('needs_review');
    expect(pending.currentVersion.id).not.toBe(root.id);
    first.sqlite.close();

    const second = openDatabase(dbPath);
    const repository = new ProjectRepository(second);
    const restored = new FixtureRun({ repository, exportRoot: join(dir, 'exports'), provider: new FakeModelProvider() });
    expect(await restored.restore('run-pending')).toBe(true);
    const after = restored.snapshot();
    expect(after.currentVersion.id).toBe(root.id);
    expect(after.status).toBe('queued');
    expect(after.approvals).toHaveLength(0);

    const next = await restored.runNext();
    expect(next.currentStage).toBe('identity');
    expect(next.currentVersion.parentId).toBe(root.id);
    const events = await repository.listEvents('run-pending');
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task.queued').map((event) => event.payload.attempt)).toEqual([1, 2]);
    second.sqlite.close();
  });
});
