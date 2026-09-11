import { mkdtemp } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@pwb/providers';
import { createApiServer } from './api.js';
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
      loadRun: async (id) => { const run = new FixtureRun({ repository, release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() }); if (!await run.restore(id)) return undefined; runs.set(id, run); return run; },
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

  it('answers 409 to a second release preparation while the first is still in flight', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-prepare-'));
    const db = openDatabase(join(dir, 'prepare.sqlite'));
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ repository: new ProjectRepository(db), release: releaseOptions(join(dir, 'exports')), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    await fetch(`${origin}/api/runs`, { method: 'POST', headers: studio, body: JSON.stringify({ runId: 'prepare-race' }) });
    // Both captain gates closed, so Gate 3 is the only one still open.
    for (const stage of ['identity', 'prototype'] as const) {
      await fetch(`${origin}/api/runs/prepare-race/stage`, { method: 'POST', headers: studio });
      await fetch(`${origin}/api/runs/prepare-race/approve`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', stage }) });
    }
    await fetch(`${origin}/api/runs/prepare-race/stage`, { method: 'POST', headers: studio });

    // Two preparations race: one compiles the gate, the other is refused the way
    // a taken run id is, instead of interleaving a second compilation into the
    // snapshot the studio will publish.
    const [first, second] = await Promise.all([
      fetch(`${origin}/api/runs/prepare-race/release`, { method: 'POST', headers: studio }),
      fetch(`${origin}/api/runs/prepare-race/release`, { method: 'POST', headers: studio }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = first.status === 409 ? first : second;
    expect(((await refused.json()) as { error: string }).error).toMatch(/já está sendo preparado/);
    const accepted = first.status === 200 ? first : second;
    const prepared = (await accepted.json()) as { digest: string };
    // The snapshot names the one preparation that ran, and a later one still works.
    expect(runs.get('prepare-race')!.releaseSnapshot()!.digest).toBe(prepared.digest);
    expect((await fetch(`${origin}/api/runs/prepare-race/release`, { method: 'POST', headers: studio })).status).toBe(200);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.sqlite.close();
  });
});
