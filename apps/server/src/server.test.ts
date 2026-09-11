import { mkdtemp } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { FakeModelProvider } from '@pwb/providers';
import { createApiServer, RunConflictError } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';

const studio = { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' };

async function rawRequestStatus(port: number, requestLine: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => { socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`); });
    let received = '';
    socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
    socket.on('end', () => resolve(received.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

function releaseOptions(root: string) {
  return { releaseRoot: root, evidenceDir: join(root, '..', 'evidence') };
}

describe('local API', () => {
  it('drives a stage and refuses non-captain approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-'));
    const db = openDatabase(join(dir, 'api.sqlite'));
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const created = await fetch(`${origin}/api/runs`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<{ runId: string }>);
    const run = runs.get(created.runId)!;
    await fetch(`${origin}/api/runs/${created.runId}/stage`, { method: 'POST', headers: studio });
    const forbidden = await fetch(`${origin}/api/runs/${created.runId}/approve`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'designer' }) });
    expect(forbidden.status).toBe(403);
    expect(run.snapshot().approvals).toHaveLength(0);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.sqlite.close();
  });

  it('refuses to recreate a run id that is already open instead of overwriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-'));
    const db = openDatabase(join(dir, 'duplicate.sqlite'));
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    await fetch(`${origin}/api/runs`, { method: 'POST', headers: studio, body: JSON.stringify({ runId: 'repeat-run' }) });
    const first = runs.get('repeat-run')!;
    await fetch(`${origin}/api/runs/repeat-run/stage`, { method: 'POST', headers: studio });
    const again = await fetch(`${origin}/api/runs`, { method: 'POST', headers: studio, body: JSON.stringify({ runId: 'repeat-run' }) });
    expect(again.status).toBe(409);
    expect(runs.get('repeat-run')).toBe(first);
    expect(first.snapshot().status).toBe('needs_review');
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.sqlite.close();
  });

  it('answers an absolute-form request target the URL parser rejects and keeps serving', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-'));
    const db = openDatabase(join(dir, 'malformed.sqlite'));
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const status = await rawRequestStatus(port, 'GET http://user@:80/ HTTP/1.1');
    expect(status).toContain('400');
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.sqlite.close();
  });

  it('refuses state-changing requests that do not come from the studio origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-'));
    const db = openDatabase(join(dir, 'csrf.sqlite'));
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    await fetch(`${origin}/api/runs`, { method: 'POST', headers: studio, body: JSON.stringify({ runId: 'csrf-run' }) });
    const run = runs.get('csrf-run')!;
    await fetch(`${origin}/api/runs/csrf-run/stage`, { method: 'POST', headers: studio });
    const crossSite = await fetch(`${origin}/api/runs/csrf-run/approve`, { method: 'POST', headers: { origin: 'http://evil.test', 'content-type': 'text/plain' }, body: JSON.stringify({ approverRole: 'captain' }) });
    const noOrigin = await fetch(`${origin}/api/runs/csrf-run/approve`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ approverRole: 'captain' }) });
    expect([crossSite.status, noOrigin.status]).toEqual([403, 403]);
    expect(run.snapshot().approvals).toHaveLength(0);
    expect(run.snapshot().status).toBe('needs_review');
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.sqlite.close();
  });

  it('serves a persisted run after a restart instead of answering 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-restart-'));
    const dbPath = join(dir, 'restart.sqlite');
    const first = openDatabase(dbPath);
    const seeded = new FixtureRun({ repository: new ProjectRepository(first), release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() });
    await seeded.initialize('persisted-run');
    await seeded.runNext();
    await seeded.approve('identity', 'captain');
    const expected = seeded.snapshot().currentVersion.id;
    first.sqlite.close();

    const second = openDatabase(dbPath);
    const repository = new ProjectRepository(second);
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({
      runs,
      createRun: async (id) => { const run = new FixtureRun({ repository, release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; },
      // The loader owns the memory-vs-ledger choice, so it answers with the run
      // this process already holds before rebuilding one from rows.
      loadRun: async (id) => { const cached = runs.get(id); if (cached) return cached; const run = new FixtureRun({ repository, release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() }); if (!await run.restore(id)) return undefined; runs.set(id, run); return run; },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const response = await fetch(`${origin}/api/runs/persisted-run`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { currentVersion: { id: string } }).currentVersion.id).toBe(expected);
    expect((await fetch(`${origin}/api/runs/never-created`)).status).toBe(404);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    second.sqlite.close();
  });

  it('refuses the chain gates of an identity execution the captain has not started yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-chain-open-'));
    const db = openDatabase(join(dir, 'chain.sqlite'));
    const repository = new ProjectRepository(db);
    // Everything `IdentityRun.initialize` writes and nothing more: the id is
    // taken and the root is stored, but the fan-out has not been asked for, so
    // the run has no events at all yet.
    const ir = createFixtureIR();
    await repository.createProject({ id: ir.meta.projectId, name: 'Identity stage project' });
    await repository.createRun({ id: 'identity-open', projectId: ir.meta.projectId, briefing: 'Briefing desta execução.' });
    await repository.saveVersion({ id: ir.meta.versionId, projectId: ir.meta.projectId, hash: 'h-identity', ir });

    const runs = new Map<string, FixtureRun>();
    const build = async (): Promise<FixtureRun> => new FixtureRun({ repository, release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() });
    const server = createApiServer({
      runs,
      createRun: async (id) => { if (await repository.getRun(id)) throw new RunConflictError(id); const run = await build(); await run.initialize(id); runs.set(id, run); return run; },
      loadRun: async (id) => { const cached = runs.get(id); if (cached) return cached; const run = await build(); if (!await run.restore(id)) return undefined; runs.set(id, run); return run; },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    // Driving the generic stage here would write a fixture-derived version and an
    // approval into the ledger the captain's own Gate 1 is about to decide in.
    const staged = await fetch(`${origin}/api/runs/identity-open/stage`, { method: 'POST', headers: studio });
    expect(staged.status).toBe(409);
    const approved = await fetch(`${origin}/api/runs/identity-open/approve`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', stage: 'identity' }) });
    expect(approved.status).toBe(409);
    expect(await repository.listApprovals('identity-open')).toEqual([]);
    expect((await repository.listVersions(ir.meta.projectId)).map((version) => version.id)).toEqual([ir.meta.versionId]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.sqlite.close();
  });

  it('refuses to run or close the chain gates of an identity execution through the fixture route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-chain-'));
    const db = openDatabase(join(dir, 'chain.sqlite'));
    const repository = new ProjectRepository(db);
    // The ledger an identity execution leaves behind: its own run, the version
    // Gate 1 closed on, and the events only that execution writes.
    const ir = createFixtureIR();
    await repository.createProject({ id: ir.meta.projectId, name: 'Identity stage project' });
    await repository.createRun({ id: 'identity-chain', projectId: ir.meta.projectId });
    await repository.saveVersion({ id: ir.meta.versionId, projectId: ir.meta.projectId, hash: 'h-identity', ir });
    await repository.appendEvent({ id: 'event-gate1', runId: 'identity-chain', type: 'identity.gate.approved', payload: { versionId: ir.meta.versionId } });
    await repository.createApproval({ id: 'identity-chain-identity-approval-0', runId: 'identity-chain', projectId: ir.meta.projectId, stage: 'identity', approverRole: 'captain', versionId: ir.meta.versionId, versionHash: 'h-identity', decision: 'approved', rationale: 'Gate 1 decidido.' });

    const runs = new Map<string, FixtureRun>();
    const build = async (): Promise<FixtureRun> => new FixtureRun({ repository, release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() });
    const server = createApiServer({
      runs,
      createRun: async (id) => { if (await repository.getRun(id)) throw new RunConflictError(id); const run = await build(); await run.initialize(id); runs.set(id, run); return run; },
      loadRun: async (id) => { const cached = runs.get(id); if (cached) return cached; const run = await build(); if (!await run.restore(id)) return undefined; runs.set(id, run); return run; },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    // Gate 2 is measured and decided by the prototype run seeded from this
    // identity; running the generic stage here would publish a bundle no Gate 2
    // ever looked at.
    const staged = await fetch(`${origin}/api/runs/identity-chain/stage`, { method: 'POST', headers: studio });
    expect(staged.status).toBe(409);
    const approved = await fetch(`${origin}/api/runs/identity-chain/approve`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', stage: 'prototype' }) });
    expect(approved.status).toBe(409);
    expect((await repository.listApprovals('identity-chain')).map((entry) => entry.stage)).toEqual(['identity']);

    // Nor may a fixture run be started over the id that execution already holds.
    const stolen = await fetch(`${origin}/api/runs`, { method: 'POST', headers: studio, body: JSON.stringify({ runId: 'identity-chain' }) });
    expect(stolen.status).toBe(409);

    const snapshot = await (await fetch(`${origin}/api/runs/identity-chain`)).json() as { currentVersion: { id: string } };
    expect(snapshot.currentVersion.id).toBe(ir.meta.versionId);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.sqlite.close();
  });
});
