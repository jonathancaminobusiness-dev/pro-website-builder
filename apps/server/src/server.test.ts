import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApiServer } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';

const studio = { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' };

describe('local API', () => {
  it('drives a stage and refuses non-captain approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-'));
    const db = openDatabase(join(dir, 'api.sqlite'));
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(dir, 'exports') }); await run.initialize(id); runs.set(id, run); return run; } });
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

  it('refuses state-changing requests that do not come from the studio origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-api-'));
    const db = openDatabase(join(dir, 'csrf.sqlite'));
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(dir, 'exports') }); await run.initialize(id); runs.set(id, run); return run; } });
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
});
