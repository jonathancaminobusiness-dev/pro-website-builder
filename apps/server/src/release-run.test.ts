import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { compileRelease, readReleasePublications } from '@pwb/export';
import { FakeModelProvider, type ModelProvider } from '@pwb/providers';
import { renderDesign } from '@pwb/renderer';
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
  report: { blocked: boolean; bundleDigest: string; irHash: string; approvedVersionId: string; releasedVersionId: string; vetoes: Array<{ id: string }>; rubric: Array<{ dimension: string }>; parity: { matched: boolean }; evidence: unknown[]; escalations: string[]; summary?: { gateAuthority: string } };
  catalog: Array<{ id: string }>;
  published?: { directory: string };
}

type EvidenceInput = Omit<Parameters<typeof writeEvidenceArtifact>[1], 'releaseDigest' | 'irHash'> & Partial<Pick<Parameters<typeof writeEvidenceArtifact>[1], 'releaseDigest' | 'irHash'>>;

const SITE = { siteUrl: 'https://oficina.example', siteName: 'Oficina' };

/** A finalization stage that rewrites a page, so its version renders different bytes. */
function pageEditingProvider(text: string): ModelProvider {
  const fake = new FakeModelProvider();
  return {
    propose: async (task, signal) => task.stage !== 'finalization' ? fake.propose(task, signal) : {
      taskId: task.id, status: 'succeeded', summary: 'rewrites the proof page',
      proposal: {
        operations: [{ op: 'replace', path: '/pages/routes/1/nodes/1/props/text', value: text }],
        baseVersionId: task.baseVersionId, touchedPaths: ['/pages/routes/1/nodes/1/props/text'],
        rationale: 'The finalization stage rewrote the proof page.', confidence: 1,
        stage: task.stage, role: task.role, idempotencyKey: `${task.id}#${task.attempt}`,
      },
    },
  };
}

async function harness(options: { evidence?: EvidenceInput[]; approveGates?: boolean; provider?: ModelProvider } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pwb-release-api-'));
  const evidenceDir = join(dir, 'evidence');
  const exportRoot = join(dir, 'exports');
  const db = openDatabase(join(dir, 'api.sqlite'));
  const repository = new ProjectRepository(db);
  const runs = new Map<string, FixtureRun>();
  const server = createApiServer({
    runs,
    createRun: async (id) => { const run = new FixtureRun({ repository, exportRoot, provider: options.provider ?? new FakeModelProvider(), ...SITE }); await run.initialize(id); runs.set(id, run); return run; },
    release: { releaseRoot: join(dir, 'releases'), evidenceDir, ...SITE, modelProvider: 'fake' },
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
  const run = runs.get(created.runId)!;
  let stageVersionId = '';
  // Gate 3 only opens once the captain has closed gates 1 and 2 on this run.
  if (options.approveGates !== false) {
    await run.runNext();
    await run.approve('identity', 'captain');
    await run.runNext();
    await run.approve('prototype', 'captain');
    await run.runNext();
    // The evidence names the release the gate will evaluate, exactly as the
    // runners do once they compile the run's document.
    const { current } = run.releaseContext();
    stageVersionId = current.id;
    const compiled = compileRelease(renderDesign(current.ir), current.ir, SITE);
    for (const entry of options.evidence ?? []) {
      await writeEvidenceArtifact(evidenceDir, { releaseDigest: compiled.digest, irHash: compiled.irHash, ...entry });
    }
  }
  const events = (id: string) => repository.listEvents(id);
  return { origin, runId: created.runId, run, releaseRoot: join(dir, 'releases'), exportRoot, evidenceDir, stageVersionId, events };
}

describe('Gate 3 over the local API', () => {
  it('prepares a release, reports it, and publishes the exact bundle the captain saw', async () => {
    const { origin, runId, releaseRoot, events } = await harness({
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

    // The evidence is incomplete, so the captain accepts the gap in writing and
    // the run records what they accepted.
    const withoutReason = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest }) });
    expect(withoutReason.status).toBe(500);
    expect((await withoutReason.json() as { error: string }).error).toMatch(/aceitar por escrito/);
    await expect(readdir(releaseRoot)).rejects.toThrow();

    const published = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Firefox não sobe nesta máquina; aceito publicar com Chromium.' }) });
    expect(published.status).toBe(200);
    expect((await readdir(releaseRoot)).filter((entry) => !entry.endsWith('.json'))).toEqual([prepared.digest]);
    // The manifest names no document and no publication, so the provenance and
    // the acceptance live in the run's log and in the release record beside it.
    const manifest = JSON.parse(await readFile(join(releaseRoot, prepared.digest, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.approvedVersionId).toBeUndefined();
    expect(manifest.irHash).toBeUndefined();
    const recorded = (await events(runId)).filter((event) => event.type === 'release.published');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({ digest: prepared.digest, versionId: prepared.versionId, rationale: 'Firefox não sobe nesta máquina; aceito publicar com Chromium.' });
    expect(recorded[0]!.payload.escalations).toEqual(prepared.report.escalations);
    expect(await readReleasePublications(releaseRoot, prepared.digest)).toEqual([{
      digest: prepared.digest,
      approvedVersionId: prepared.report.approvedVersionId,
      releasedVersionId: prepared.versionId,
      irHash: prepared.report.irHash,
      approverRole: 'captain',
      rationale: 'Firefox não sobe nesta máquina; aceito publicar com Chromium.',
      acceptedEscalations: prepared.report.escalations,
    }]);

    // Publishing the same bytes again is an idempotent success that appends the
    // second publication to the release record.
    const again = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Republicando os mesmos bytes.' }) });
    expect(again.status).toBe(200);
    expect((await readdir(releaseRoot)).filter((entry) => !entry.endsWith('.json'))).toEqual([prepared.digest]);
    const publications = await readReleasePublications(releaseRoot, prepared.digest);
    expect(publications).toHaveLength(2);
    expect(publications[1]?.rationale).toBe('Republicando os mesmos bytes.');
  });

  it('refuses Gate 3 until the captain has approved identity and prototype', async () => {
    const { origin, runId, releaseRoot } = await harness({ approveGates: false });
    const refused = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toMatch(/aprovação do capitão na etapa de identidade/);
    const publish = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: 'qualquer' }) });
    expect(publish.status).toBe(409);
    await expect(readdir(releaseRoot)).rejects.toThrow();
  });

  it('compiles the finalization-stage version, keeps the refinement retrievable, and refines only once', async () => {
    const { origin, runId, evidenceDir, stageVersionId, events } = await harness({
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'failed', path: 'p', hash: 'h', vetoes: [], metrics: { critical: 1, serious: 0 }, notes: ['contraste'] }],
    });
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.report.approvedVersionId).toBe(stageVersionId);
    // The refiner recorded the open finding, so the released version is a real
    // version of this run rather than one that existed only inside the gate.
    expect(prepared.versionId).not.toBe(stageVersionId);
    const document = JSON.parse(await readFile(join(evidenceDir, 'release-document.json'), 'utf8')) as { meta: { versionId: string } };
    expect(document.meta.versionId).toBe(stageVersionId);

    // A second Gate 3 run starts from the refinement, and rewriting what the
    // review record already says mints no further version.
    const again = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(again.report.approvedVersionId).toBe(stageVersionId);
    expect(again.versionId).toBe(prepared.versionId);
    const second = JSON.parse(await readFile(join(evidenceDir, 'release-document.json'), 'utf8')) as { meta: { versionId: string }; reviewRecord: { findings: string[] } };
    expect(second.meta.versionId).toBe(prepared.versionId);
    expect(second.reviewRecord.findings.join(' ')).toMatch(/axe-home/);
    expect((await events(runId)).filter((event) => event.type === 'release.refined')).toHaveLength(1);
  });

  it('exports the document Gate 3 released, not a sibling of it, when the finalization stage edits a page', async () => {
    const edited = 'Prova antes do brilho, revisada na finalização.';
    const { origin, runId, exportRoot, run } = await harness({
      provider: pageEditingProvider(edited),
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'failed', path: 'p', hash: 'h', vetoes: [], metrics: { critical: 1, serious: 0 }, notes: ['contraste'] }],
    });
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    const snapshot = await run.approve('finalization', 'captain');
    const approval = snapshot.approvals.find((entry) => entry.stage === 'finalization' && entry.decision === 'approved')!;
    // The approval, the release record and the published bytes all name one version.
    expect(approval.versionId).toBe(prepared.versionId);
    expect(snapshot.exportManifest!.digest).toBe(prepared.digest);
    const [publication] = await readReleasePublications(exportRoot, snapshot.exportManifest!.digest);
    expect(publication?.releasedVersionId).toBe(prepared.versionId);
    expect(publication?.approvedVersionId).toBe(prepared.report.approvedVersionId);
    expect(await readFile(join(exportRoot, snapshot.exportManifest!.digest, 'proof', 'index.html'), 'utf8')).toContain(edited);
  });

  it('closes Gate 3 again when the captain rejects the finalization proposal', async () => {
    const { origin, runId, run, releaseRoot } = await harness();
    await run.reject('finalization', 'captain');
    const refused = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toMatch(/etapa de finalização ainda não produziu/);
    await expect(readdir(releaseRoot)).rejects.toThrow();

    // Re-running the stage produces a new version, and Gate 3 compiles that one.
    await run.runNext();
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.report.approvedVersionId).toBe(run.snapshot().currentVersion.id);
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
