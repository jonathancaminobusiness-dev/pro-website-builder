import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@pwb/providers';
import { openDatabase, ProjectRepository } from './db/repository.js';
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
    expect(await readdir(snapshot.exportManifest!.directory)).toEqual(expect.arrayContaining(['index.html', 'manifest.json', 'assets', 'proof', 'contact']));
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
    const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(await mkdtemp(join(tmpdir(), 'pwb-reject-')), 'exports'), provider: new FakeModelProvider() });
    await run.initialize('run-reject');
    await run.runNext();
    const rejected = await run.reject('identity', 'captain');
    expect(rejected.status).toBe('rejected');
    expect(rejected.approvals.at(-1)?.decision).toBe('rejected');
    const rerun = await run.runNext();
    expect(rerun.status).toBe('needs_review');
    expect(rerun.currentStage).toBe('identity');
    expect(rerun.currentVersion.id).not.toBe(rejected.currentVersion.id);
    expect((await run.runAll()).status).toBe('succeeded');
    db.sqlite.close();
  });

  it('cancels before apply and restarts from the same immutable revision', async () => {
    const db = openDatabase(':memory:');
    const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: '/tmp/pwb-fixture-test', provider: new FakeModelProvider() });
    await run.initialize('run-2');
    const rootId = run.snapshot().currentVersion.id;
    run.cancel();
    expect(run.snapshot().status).toBe('cancelled');
    expect(run.snapshot().currentVersion.id).toBe(rootId);
    run.restart();
    expect((await run.runAll()).status).toBe('succeeded');
    db.sqlite.close();
  });
});
