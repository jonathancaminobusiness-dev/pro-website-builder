import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, type EvidenceArtifact } from '@pwb/domain';
import { compileRelease, readReleasePublications } from '@pwb/export';
import { FakeModelProvider, type ModelProvider } from '@pwb/providers';
import { renderDesign } from '@pwb/renderer';
import { writeEvidenceArtifact } from '@pwb/stage-finalization';
import { openDatabase, ProjectRepository, type LocalDatabase } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';

/** One bundle root per run, with the evidence directory Gate 3 reads beside it. */
function releaseOptions(root: string) {
  return { releaseRoot: root, evidenceDir: join(root, '..', 'evidence') };
}

/**
 * Every runner and engine Gate 3 requires, clean, stamped with the release the
 * run is about to evaluate — so the report has nothing left for a human to
 * accept and a scripted publication is honest.
 */
async function completeEvidence(run: FixtureRun, evidenceDir: string): Promise<void> {
  const { current } = run.releaseContext();
  const compiled = compileRelease(renderDesign(current.ir), current.ir, { siteUrl: 'https://site.invalid', siteName: 'pro-website-builder' });
  const base = { releaseDigest: compiled.digest, irHash: compiled.irHash, route: '/', status: 'passed' as const, path: 'p', hash: 'h', metrics: {}, notes: [] };
  const artifacts: EvidenceArtifact[] = [
    { ...base, id: 'vitest', runner: 'vitest', engine: 'node', state: 'unit' },
    { ...base, id: 'pw-chromium', runner: 'playwright', engine: 'chromium', state: 'width-1440' },
    { ...base, id: 'pw-firefox', runner: 'playwright', engine: 'firefox', state: 'width-1440' },
    { ...base, id: 'pw-webkit', runner: 'playwright', engine: 'webkit', state: 'width-1440' },
    { ...base, id: 'axe-home', runner: 'axe', engine: 'chromium', state: 'default', metrics: { critical: 0, serious: 0 } },
    { ...base, id: 'lh-mobile', runner: 'lighthouse', engine: 'chromium', state: 'mobile', metrics: { performance: 98 } },
  ];
  for (const artifact of artifacts) await writeEvidenceArtifact(evidenceDir, artifact);
}

/** Walks a run to the finalization gate, which only Gate 3 can close. */
async function atFinalizationGate(run: FixtureRun): Promise<void> {
  await run.runNext();
  await run.approve('identity', 'captain');
  await run.runNext();
  await run.approve('prototype', 'captain');
  await run.runNext();
}

describe('phase 0 fixture run', () => {
  it('walks the three stages and stops at Gate 3 instead of publishing on its own', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-run-'));
    const db = openDatabase(join(dir, 'run.sqlite'));
    const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(dir, 'releases')), provider: new FakeModelProvider() });
    await run.initialize('run-1');
    const snapshot = await run.runAll();
    expect(snapshot.status).toBe('needs_review');
    expect(snapshot.currentStage).toBe('finalization');
    expect(snapshot.approvals.map((entry) => entry.stage)).toEqual(['identity', 'prototype']);
    // With no evidence the gate has open points, and only the captain may accept them.
    const report = run.releaseSnapshot()!.report;
    expect(report.escalations.length).toBeGreaterThan(0);
    await expect(run.publishRelease(report.bundleDigest, 'aceito', 'fixture')).rejects.toThrow(/só o capitão pode aceitar/i);
    await expect(readdir(join(dir, 'releases'))).rejects.toThrow();
    db.sqlite.close();
  });

  it('publishes under its own name once Gate 3 has nothing left to accept', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-publish-'));
    const db = openDatabase(join(dir, 'run.sqlite'));
    const releaseRoot = join(dir, 'releases');
    const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(releaseRoot), provider: new FakeModelProvider() });
    await run.initialize('run-publish');
    await atFinalizationGate(run);
    await completeEvidence(run, join(releaseRoot, '..', 'evidence'));
    const prepared = await run.prepareRelease();
    expect(prepared.report.blocked).toBe(false);
    expect(prepared.report.escalations).toEqual([]);

    await run.publishRelease(prepared.digest, 'Publicado por um fixture, sem decisão humana.', 'fixture');
    const snapshot = run.snapshot();
    expect(snapshot.status).toBe('succeeded');
    expect(snapshot.approvals).toHaveLength(3);
    expect(snapshot.approvals.at(-1)?.approverRole).toBe('fixture');
    expect(snapshot.exportManifest?.routes.map((route) => route.route)).toEqual(['/', '/proof', '/contact']);
    expect((await readdir(join(releaseRoot, snapshot.exportManifest!.digest))).sort()).toEqual(['assets', 'contact', 'headers.json', 'index.html', 'licenses.json', 'manifest.json', 'proof', 'robots.txt', 'sitemap.xml']);
    db.sqlite.close();
  });

  it('refuses to prepare the release again once publishing closed the gate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-reprepare-'));
    const db = openDatabase(join(dir, 'run.sqlite'));
    const releaseRoot = join(dir, 'releases');
    const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(releaseRoot), provider: new FakeModelProvider() });
    await run.initialize('run-reprepare');
    await atFinalizationGate(run);
    await completeEvidence(run, join(releaseRoot, '..', 'evidence'));
    const prepared = await run.prepareRelease();
    await run.publishRelease(prepared.digest, 'Publicado por um fixture.', 'fixture');

    expect(run.releaseBlocker()).toMatch(/não está aberto/);
    await expect(run.prepareRelease()).rejects.toThrow(/não está aberto/);
    expect(run.snapshot().status).toBe('succeeded');
    expect(run.snapshot().currentVersion.id).toBe(prepared.versionId);
    expect(run.releaseSnapshot()?.published?.digest).toBe(prepared.digest);
    db.sqlite.close();
  });

  it('writes an append-only event log for the whole journey', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const releaseRoot = join(await mkdtemp(join(tmpdir(), 'pwb-events-')), 'releases');
    const run = new FixtureRun({ repository, release: releaseOptions(releaseRoot), provider: new FakeModelProvider() });
    await run.initialize('run-events');
    await run.runAll();
    await completeEvidence(run, join(releaseRoot, '..', 'evidence'));
    const prepared = await run.prepareRelease();
    await run.publishRelease(prepared.digest, 'Publicado por um fixture.', 'fixture');
    const events = await repository.listEvents('run-events');
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['run.created', 'run.started', 'task.queued', 'task.started', 'task.succeeded', 'patch.applied', 'version.created', 'approval.recorded', 'release.published', 'run.finished']));
    expect(events.at(-1)?.type).toBe('run.finished');
    expect(events.filter((event) => event.type === 'approval.recorded')).toHaveLength(3);
    db.sqlite.close();
  });

  it('lets the captain re-run a stage that was rejected', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const run = new FixtureRun({ repository, release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-reject-')), 'exports')), provider: new FakeModelProvider() });
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
    expect((await run.runAll()).currentStage).toBe('finalization');
    db.sqlite.close();
  });

  it('holds the prototype stage until the captain approves identity, across a rejected re-run', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const fake = new FakeModelProvider();
    const attempted: string[] = [];
    const recording: ModelProvider = { async propose(task, signal) { attempted.push(`${task.stage}#${task.attempt}`); return fake.propose(task, signal); } };
    const run = new FixtureRun({ repository, release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-order-')), 'exports')), provider: recording });
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

  it('records the finalization approval only after the bundle reaches disk', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const dir = await mkdtemp(join(tmpdir(), 'pwb-license-'));
    const blocked = join(dir, 'not-a-directory');
    await writeFile(blocked, 'the release root cannot be created under a regular file', 'utf8');
    const run = new FixtureRun({ repository, release: { releaseRoot: join(blocked, 'releases'), evidenceDir: join(dir, 'evidence') }, provider: new FakeModelProvider() });
    await run.initialize('run-license');
    await atFinalizationGate(run);
    expect(run.snapshot().currentStage).toBe('finalization');
    const prepared = await run.prepareRelease();
    await expect(run.publishRelease(prepared.digest, 'aceito')).rejects.toThrow(/ENOTDIR|not a directory/i);
    await expect(run.publishRelease(prepared.digest, 'aceito')).rejects.toThrow(/ENOTDIR|not a directory/i);
    expect(run.snapshot().approvals.filter((entry) => entry.stage === 'finalization')).toHaveLength(0);
    expect(run.snapshot().status).toBe('needs_review');
    const recorded = (await repository.listEvents('run-license')).filter((event) => event.type === 'approval.recorded' && event.payload.stage === 'finalization');
    expect(recorded).toHaveLength(0);
    db.sqlite.close();
  });

  it('has no second way to approve the finalization gate', async () => {
    const db = openDatabase(':memory:');
    const dir = await mkdtemp(join(tmpdir(), 'pwb-single-'));
    const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(dir, 'releases')), provider: new FakeModelProvider() });
    await run.initialize('run-single');
    await atFinalizationGate(run);
    await expect(run.approve('finalization', 'captain')).rejects.toThrow(/Gate 3/);
    expect(run.snapshot().status).toBe('needs_review');
    await expect(readdir(join(dir, 'releases'))).rejects.toThrow();
    db.sqlite.close();
  });

  it('refuses to publish a release whose page carries a secret', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const dir = await mkdtemp(join(tmpdir(), 'pwb-secret-'));
    const releaseRoot = join(dir, 'releases');
    // The finalization stage writes a page whose copy leaks an API key; the one
    // publish path is the release gate, so the veto refuses it.
    const leaking: ModelProvider = {
      propose: async (task) => task.stage !== 'finalization'
        ? new FakeModelProvider().propose(task)
        : {
          taskId: task.id, status: 'succeeded', summary: 'leaks a credential',
          proposal: {
            operations: [{ op: 'replace', path: '/pages/routes/0/nodes/1/props/text', value: 'A chave é sk-ant-api03-0123456789abcdefghijklmnop e ela vazou.' }],
            baseVersionId: task.baseVersionId, touchedPaths: ['/pages/routes/0/nodes/1/props/text'],
            rationale: 'fixture that leaks a credential', confidence: 1,
            stage: task.stage, role: task.role, idempotencyKey: `${task.id}#${task.attempt}`,
          },
        },
    };
    const run = new FixtureRun({ repository, release: { releaseRoot, evidenceDir: join(dir, 'evidence') }, provider: leaking });
    await run.initialize('run-secret');
    await atFinalizationGate(run);
    const prepared = await run.prepareRelease();
    expect(prepared.report.vetoes.map((veto) => veto.id)).toContain('SECRET_IN_BUNDLE');
    await expect(run.publishRelease(prepared.digest, 'aceito')).rejects.toThrow(/SECRET_IN_BUNDLE/);
    expect(run.snapshot().status).toBe('needs_review');
    expect(run.snapshot().approvals.filter((entry) => entry.stage === 'finalization')).toHaveLength(0);
    await expect(readdir(releaseRoot)).rejects.toThrow();
    db.sqlite.close();
  });

  it('refuses a second publish that races the first one', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const dir = await mkdtemp(join(tmpdir(), 'pwb-race-publish-'));
    const releaseRoot = join(dir, 'releases');
    const run = new FixtureRun({ repository, release: releaseOptions(releaseRoot), provider: new FakeModelProvider() });
    await run.initialize('run-race-publish');
    await atFinalizationGate(run);
    await completeEvidence(run, join(releaseRoot, '..', 'evidence'));
    const prepared = await run.prepareRelease();
    const [first, second] = await Promise.allSettled([
      run.publishRelease(prepared.digest, 'primeira', 'fixture'),
      run.publishRelease(prepared.digest, 'segunda', 'fixture'),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(run.snapshot().approvals.filter((entry) => entry.stage === 'finalization')).toHaveLength(1);
    expect(await readReleasePublications(releaseRoot, prepared.digest)).toHaveLength(1);
    expect((await repository.listEvents('run-race-publish')).filter((event) => event.type === 'run.finished')).toHaveLength(1);
    db.sqlite.close();
  });

  it('refuses a second gate decision that races the first one', async () => {
    const db = openDatabase(':memory:');
    const repository = new ProjectRepository(db);
    const run = new FixtureRun({ repository, release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-race-gate-')), 'exports')), provider: new FakeModelProvider() });
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
    const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-race-approve-')), 'exports')), provider: new FakeModelProvider() });
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
    const run = new FixtureRun({ repository, release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-rewind-')), 'exports')), provider: proposer });
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
    const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-start-')), 'exports')), provider: recording });
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
    const run = new FixtureRun({ repository, release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-throw-')), 'exports')), provider: flaky });
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
    const run = new FixtureRun({ repository, release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-restart-')), 'exports')), provider: new FakeModelProvider() });
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
    run = new FixtureRun({ repository, release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-race-')), 'exports')), provider: new FakeModelProvider() });
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
    run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-abort-')), 'exports')), provider: watcher });
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
    const run = new FixtureRun({ repository, release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-rename-')), 'exports')), provider: renamer });
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
    const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-restart-')), 'exports')), provider: new FakeModelProvider() });
    await run.initialize('run-2');
    const rootId = run.snapshot().currentVersion.id;
    await run.cancel();
    expect(run.snapshot().status).toBe('cancelled');
    expect(run.snapshot().currentVersion.id).toBe(rootId);
    await run.restart();
    const finished = await run.runAll();
    expect(finished.currentStage).toBe('finalization');
    expect(finished.currentVersion.id).not.toBe(rootId);
    db.sqlite.close();
  });

  it('refuses to approve a version that carries lint errors', async () => {
    const db = openDatabase(':memory:');
    const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-lint-')), 'exports')), provider: new FakeModelProvider() });
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
    const run = new FixtureRun({ repository: new FailingRepository(db), release: releaseOptions(join(await mkdtemp(join(tmpdir(), 'pwb-approve-')), 'exports')), provider: new FakeModelProvider() });
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
    const original = new FixtureRun({ repository: new ProjectRepository(first), release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() });
    await original.initialize('run-restore');
    await original.runNext();
    await original.approve('identity', 'captain');
    const before = original.snapshot();
    first.sqlite.close();

    const second = openDatabase(dbPath);
    const restored = new FixtureRun({ repository: new ProjectRepository(second), release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() });
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
    const original = new FixtureRun({ repository: new ProjectRepository(first), release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() });
    await original.initialize('run-pending');
    const root = original.snapshot().currentVersion;
    const pending = await original.runNext();
    expect(pending.status).toBe('needs_review');
    expect(pending.currentVersion.id).not.toBe(root.id);
    first.sqlite.close();

    const second = openDatabase(dbPath);
    const repository = new ProjectRepository(second);
    const restored = new FixtureRun({ repository, release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() });
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

describe('the release gate reads the gates this document actually passed', () => {
  it('refuses a bundle that does not descend from the version a gate was decided on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-ancestry-'));
    const dbPath = join(dir, 'ancestry.sqlite');
    const first = openDatabase(dbPath);
    const repository = new ProjectRepository(first);
    const run = new FixtureRun({ repository, release: releaseOptions(join(dir, 'releases')), provider: new FakeModelProvider() });
    await run.initialize('run-ancestry');
    const root = run.snapshot().currentVersion;
    await run.runNext();
    await run.approve('identity', 'captain');
    const identityVersion = run.snapshot().currentVersion;

    // A revision of the same project that shares only the root with what Gate 1
    // approved — a second branch, the way an alternative candidate is — carrying
    // a prototype approval of its own.
    const sibling = { ...createFixtureIR(), meta: { ...createFixtureIR().meta, versionId: 'v-sibling' } };
    sibling.pages.routes[0]!.title = 'Outro ramo';
    await repository.saveVersion({ id: 'v-sibling', projectId: root.ir.meta.projectId, parentId: root.id, hash: 'h-sibling', ir: sibling });
    await repository.createApproval({
      id: 'run-ancestry-prototype-sibling', runId: 'run-ancestry', projectId: root.ir.meta.projectId, stage: 'prototype',
      approverRole: 'captain', versionId: 'v-sibling', versionHash: 'h-sibling', decision: 'approved', rationale: 'Aprovado em outro ramo.',
    });
    first.sqlite.close();

    const second = openDatabase(dbPath);
    const restored = new FixtureRun({ repository: new ProjectRepository(second), release: releaseOptions(join(dir, 'releases')), provider: new FakeModelProvider() });
    expect(await restored.restore('run-ancestry')).toBe(true);
    // Both gates are closed and the finalization stage has run, so only the
    // ancestry of the compiled document stands between this and a release.
    const finalized = await restored.runNext();
    expect(finalized.currentStage).toBe('finalization');
    const blocker = restored.releaseBlocker();
    expect(blocker).toMatch(/não descende/);
    expect(blocker).toContain(identityVersion.id);
    await expect(restored.prepareRelease()).rejects.toThrow(/não descende/);
    second.sqlite.close();
  });

  it('opens the gate for a bundle that descends from both decided versions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-ancestry-ok-'));
    const db = openDatabase(join(dir, 'ancestry.sqlite'));
    const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(dir, 'releases')), provider: new FakeModelProvider() });
    await run.initialize('run-ancestry-ok');
    await atFinalizationGate(run);
    const approved = run.snapshot().approvals.map((entry) => entry.versionId);
    expect(run.releaseBlocker()).toBeUndefined();
    const prepared = await run.prepareRelease();
    expect(approved).toHaveLength(2);
    expect(prepared.report.approvedVersionId).toBeTruthy();
    db.sqlite.close();
  });
});
