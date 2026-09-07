import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    expect(new Set(identityTasks.map((task) => task.base_version_id)).size).toBe(2);
    expect(identityTasks.map((task) => task.base_version_id)).toContain(rejected.currentVersion.id);
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
        return { taskId: task.id, status: 'succeeded', summary: 'Rename a token', proposal: { op: 'proposal', operations: [{ op: 'remove', path: '/identity/tokens/color/ink' }], baseVersionId: task.baseVersionId, touchedPaths: ['/identity/tokens/color/ink'], rationale: 'Rename the ink token', confidence: 1, stage: task.stage, role: task.role, idempotencyKey: `rename-${task.stage}` } };
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
});
