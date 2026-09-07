import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@pwb/providers';
import { writeEvidenceArtifact } from '@pwb/stage-finalization';
import { createApiServer } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';

const studio = { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

interface ReleaseSnapshot {
  digest: string;
  versionId: string;
  report: { blocked: boolean; vetoes: Array<{ id: string }>; rubric: Array<{ dimension: string }>; parity: { matched: boolean }; evidence: unknown[]; escalations: string[]; summary?: { gateAuthority: string } };
  catalog: Array<{ id: string }>;
  published?: { directory: string };
}

async function harness(options: { evidence?: Parameters<typeof writeEvidenceArtifact>[1][] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pwb-release-api-'));
  const evidenceDir = join(dir, 'evidence');
  for (const artifact of options.evidence ?? []) await writeEvidenceArtifact(evidenceDir, artifact);
  const db = openDatabase(join(dir, 'api.sqlite'));
  const runs = new Map<string, FixtureRun>();
  const server = createApiServer({
    runs,
    createRun: async (id) => { const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(dir, 'exports'), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; },
    release: { releaseRoot: join(dir, 'releases'), evidenceDir, siteUrl: 'https://oficina.example', siteName: 'Oficina', modelProvider: 'fake' },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  });
  const created = await fetch(`${origin}/api/runs`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<{ runId: string }>);
  return { origin, runId: created.runId, releaseRoot: join(dir, 'releases') };
}

describe('Gate 3 over the local API', () => {
  it('prepares a release, reports it, and publishes the exact bundle the captain saw', async () => {
    const { origin, runId, releaseRoot } = await harness({
      evidence: [
        { id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'passed', path: 'p', hash: 'h', vetoes: [], metrics: { critical: 0, serious: 0 }, notes: [] },
        { id: 'vitest', runner: 'vitest', engine: 'node', route: '/', state: 'unit', status: 'passed', path: 'p', hash: 'h', vetoes: [], metrics: {}, notes: [] },
      ],
    });
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.report.blocked).toBe(false);
    expect(prepared.report.rubric).toHaveLength(5);
    expect(prepared.report.parity.matched).toBe(true);
    expect(prepared.report.evidence).toHaveLength(2);
    expect(prepared.report.summary?.gateAuthority).toBe('none');
    expect(prepared.catalog).toHaveLength(8);

    const fetched = await fetch(`${origin}/api/runs/${runId}/release`).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(fetched.digest).toBe(prepared.digest);

    const published = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest }) });
    expect(published.status).toBe(200);
    expect(await readdir(releaseRoot)).toEqual([prepared.digest]);
  });

  it('refuses to publish for anyone but the captain', async () => {
    const { origin, runId } = await harness();
    await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio });
    const forbidden = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'designer', digest: 'x' }) });
    expect(forbidden.status).toBe(403);
  });

  it('refuses to publish a bundle other than the one the report describes', async () => {
    const { origin, runId, releaseRoot } = await harness();
    await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio });
    const stale = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: 'a-digest-from-an-older-report' }) });
    expect(stale.status).toBe(500);
    expect((await stale.json() as { error: string }).error).toMatch(/aprovou o bundle/);
    await expect(readdir(releaseRoot)).rejects.toThrow();
  });

  it('refuses to publish while a veto stands, and leaves nothing on disk', async () => {
    const { origin, runId, releaseRoot } = await harness({
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'failed', path: 'p', hash: 'h', vetoes: [], metrics: { critical: 1, serious: 0 }, notes: ['contrast'] }],
    });
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.report.blocked).toBe(true);
    expect(prepared.report.vetoes.map((veto) => veto.id)).toContain('CRITICAL_AA_REGRESSION');
    const blocked = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest }) });
    expect(blocked.status).toBe(500);
    expect((await blocked.json() as { error: string }).error).toMatch(/CRITICAL_AA_REGRESSION/);
    await expect(readdir(releaseRoot)).rejects.toThrow();
  });

  it('has no release routes when the server does not serve the finalization stage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-release-off-'));
    const db = openDatabase(join(dir, 'api.sqlite'));
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(dir, 'exports'), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      db.sqlite.close();
      await rm(dir, { recursive: true, force: true });
    });
    const created = await fetch(`${origin}/api/runs`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<{ runId: string }>);
    expect((await fetch(`${origin}/api/runs/${created.runId}/release`, { method: 'POST', headers: studio })).status).toBe(404);
  });
});
