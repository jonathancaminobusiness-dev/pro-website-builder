import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { compileRelease, readReleasePublications, type FontDecision, type ServedFace } from '@pwb/export';
import { FakeModelProvider, type ModelProvider } from '@pwb/providers';
import { renderDesign } from '@pwb/renderer';
import { writeEvidenceArtifact } from '@pwb/stage-finalization';
import { createApiServer } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';
import { startServedPreview } from './preview.js';

const studio = { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

interface ReleaseSnapshot {
  digest: string;
  versionId: string;
  report: { blocked: boolean; bundleDigest: string; irHash: string; approvedVersionId: string; releasedVersionId: string; vetoes: Array<{ id: string }>; rubric: Array<{ dimension: string }>; parity: { matched: boolean; routes: Array<{ route: string; differences: string[] }> }; evidence: unknown[]; escalations: string[]; refinementCycles: number; summary?: { gateAuthority: string } };
  catalog: Array<{ id: string }>;
  published?: { directory: string; digest: string };
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
        operations: [{ op: 'replace', path: '/pages/routes/1/nodes/1/props/text', value: `${text} (tentativa ${task.attempt})` }],
        baseVersionId: task.baseVersionId, touchedPaths: ['/pages/routes/1/nodes/1/props/text'],
        rationale: 'The finalization stage rewrote the proof page.', confidence: 1,
        stage: task.stage, role: task.role, idempotencyKey: `${task.id}#${task.attempt}`,
      },
    },
  };
}

async function harness(options: { evidence?: EvidenceInput[]; approveGates?: boolean; provider?: ModelProvider; fontsDir?: string; previewFaces?: (version: { id: string }) => ServedFace[] | undefined } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pwb-release-api-'));
  const evidenceDir = join(dir, 'evidence');
  const releaseRoot = join(dir, 'releases');
  const db = openDatabase(join(dir, 'api.sqlite'));
  const repository = new ProjectRepository(db);
  const runs = new Map<string, FixtureRun>();
  const server = createApiServer({
    runs,
    createRun: async (id) => { const run = new FixtureRun({ modelProvider: 'fake', repository, provider: options.provider ?? new FakeModelProvider(), release: { releaseRoot, evidenceDir, ...SITE, ...(options.fontsDir ? { fontsDir: options.fontsDir } : {}), ...(options.previewFaces ? { previewFaces: options.previewFaces } : {}) } }); await run.initialize(id); runs.set(id, run); return run; },
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
  return { origin, runId: created.runId, run, releaseRoot, evidenceDir, stageVersionId, events, repository, db };
}

describe('Gate 3 over the local API', () => {
  it('prepares a release, reports it, and publishes the exact bundle the captain saw', async () => {
    const { origin, runId, releaseRoot, events, run } = await harness({
      evidence: [
        { id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'passed', path: 'p', hash: 'h', metrics: { critical: 0, serious: 0 }, notes: [] },
        { id: 'vitest', runner: 'vitest', engine: 'node', route: '/', state: 'unit', status: 'passed', path: 'p', hash: 'h', metrics: {}, notes: [] },
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
    expect(withoutReason.status).toBe(409);
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

    // Publishing is the finalization approval, so the gate is closed afterwards
    // and a second publication is refused rather than recorded twice.
    expect(run.snapshot().status).toBe('succeeded');
    expect(run.snapshot().approvals.filter((entry) => entry.stage === 'finalization')).toHaveLength(1);
    const again = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Republicando os mesmos bytes.' }) });
    expect(again.status).toBe(409);
    expect((await again.json() as { error: string }).error).toMatch(/não está aberto/);
    // A closed gate does not reopen: preparing again would move a finished run's document.
    const reprepare = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio });
    expect(reprepare.status).toBe(409);
    expect(run.snapshot().currentVersion.id).toBe(prepared.versionId);
    expect((await readdir(releaseRoot)).filter((entry) => !entry.endsWith('.json'))).toEqual([prepared.digest]);
    expect(await readReleasePublications(releaseRoot, prepared.digest)).toHaveLength(1);
  });

  it('refuses a second preparation while one is still in flight', async () => {
    const { origin, runId, run } = await harness();
    // The claim is taken before the first await, so the route sees it while the
    // first preparation is still compiling: two of them would interleave the
    // snapshot, the compiled bytes and the refiner's idempotency key.
    const inFlight = run.prepareRelease();
    const refused = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toMatch(/já está sendo preparado/);

    const prepared = await inFlight;
    expect(run.releaseSnapshot()?.digest).toBe(prepared.digest);
    // The claim is released with the preparation, so the gate still prepares.
    const again = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio });
    expect(again.status).toBe(200);
  });

  it('ships the faces the project offers, and the release record carries their terms', async () => {
    const bytes = Buffer.from([119, 79, 70, 50, 9, 8, 7, 6]);
    const fontsDir = await mkdtemp(join(tmpdir(), 'pwb-run-fonts-'));
    cleanups.push(async () => { await rm(fontsDir, { recursive: true, force: true }); });
    await writeFile(join(fontsDir, 'fixture-sans-400.woff2'), bytes);
    await writeFile(join(fontsDir, 'manifest.json'), JSON.stringify({
      faces: [
        { family: 'Fixture Sans', weight: '400', style: 'normal', format: 'woff2', file: 'fixture-sans-400.woff2', license: 'ofl-1.1', licenseUrl: 'https://openfontlicense.org', source: 'https://fonts.example/fixture-sans', author: 'Fixture Foundry', date: '2026-09-07' },
        { family: 'Foundry Grotesk', weight: '400', style: 'normal', format: 'woff2', file: 'fixture-sans-400.woff2', license: 'Foundry desktop licence', source: 'invoice 42', author: 'Foundry', date: '2026-09-07' },
      ],
    }), 'utf8');

    const { origin, runId, releaseRoot } = await harness({ fontsDir });
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.report.blocked).toBe(false);
    const published = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Aceito os pontos em aberto.' }) });
    expect(published.status).toBe(200);

    // The bundle is a public artifact: the face it may redistribute is in it,
    // the one it may not is named in the inventory and left out of the bytes.
    const bundle = join(releaseRoot, prepared.digest);
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as { stylesheetPath: string; fonts: Array<Record<string, unknown> & { family: string; selfHosted: boolean; path?: string }> };
    const hosted = manifest.fonts.find((font) => font.family === 'Fixture Sans')!;
    expect(hosted.selfHosted).toBe(true);
    expect(await readFile(join(bundle, hosted.path!))).toEqual(bytes);
    expect(await readFile(join(bundle, manifest.stylesheetPath), 'utf8')).toContain(`src:url("${hosted.path!.replace('assets/', '')}")`);
    // The manifest publishes what the release decided about each face and nothing
    // the owner declared about one it does not ship.
    expect(manifest.fonts.find((font) => font.family === 'Foundry Grotesk')).toEqual({
      family: 'Foundry Grotesk', weight: '400', style: 'normal', format: 'woff2',
      selfHosted: false, license: 'Foundry desktop licence', reason: expect.stringMatching(/does not clearly permit/),
    });
    // The inventory states the provenance the owner declared for the face the
    // release ships, not a substitute derived from the bundle.
    const licenses = JSON.parse(await readFile(join(bundle, 'licenses.json'), 'utf8')) as Array<{ id: string; kind: string; license: string; bundled: boolean; author: string; source: string; date: string; hash: string; licenseUrl?: string }>;
    const [hostedRow, unhostedRow, ...others] = licenses.filter((entry) => entry.kind === 'font');
    expect(others).toEqual([]);
    expect(hostedRow).toMatchObject({
      id: 'font:Fixture Sans:400:normal', license: 'ofl-1.1', licenseUrl: 'https://openfontlicense.org',
      author: 'Fixture Foundry', source: 'https://fonts.example/fixture-sans', date: '2026-09-07', bundled: true,
    });
    expect(hostedRow!.hash).toMatch(/^[0-9a-f]{64}$/);
    // A face the release never serves is named with its licence and why it stays
    // out; the private reference the owner declared for it is not published.
    expect(unhostedRow).toMatchObject({
      id: 'font:Foundry Grotesk:400:normal', license: 'Foundry desktop licence',
      author: '', source: 'not bundled', date: '', hash: '', bundled: false,
    });
    expect(unhostedRow?.licenseUrl).toBeUndefined();
    const publicArtifacts = `${await readFile(join(bundle, 'licenses.json'), 'utf8')}${await readFile(join(bundle, 'manifest.json'), 'utf8')}`;
    expect(publicArtifacts).not.toContain('invoice 42');
  });

  it('compares the faces a preview really served, so a scripted run has nothing open about them', async () => {
    const bytes = Buffer.from([119, 79, 70, 50, 5, 5, 5, 5]);
    const fontsDir = await mkdtemp(join(tmpdir(), 'pwb-run-served-fonts-'));
    cleanups.push(async () => { await rm(fontsDir, { recursive: true, force: true }); });
    await writeFile(join(fontsDir, 'fixture-sans-400.woff2'), bytes);
    await writeFile(join(fontsDir, 'foundry-grotesk-400.woff2'), Buffer.from([119, 79, 70, 50, 6, 6, 6, 6]));
    // The second face may not be redistributed, so neither view declares it and
    // both fall back to the same stack: it is not a divergence.
    await writeFile(join(fontsDir, 'manifest.json'), JSON.stringify({
      faces: [
        { family: 'Fixture Sans', weight: '400', style: 'normal', format: 'woff2', file: 'fixture-sans-400.woff2', license: 'ofl-1.1', source: 'https://fonts.example/fixture-sans', author: 'Fixture Foundry', date: '2026-09-07' },
        { family: 'Foundry Grotesk', weight: '400', style: 'normal', format: 'woff2', file: 'foundry-grotesk-400.woff2', license: 'Foundry desktop licence', source: 'https://fonts.example/foundry-grotesk', author: 'Foundry', date: '2026-09-07' },
      ],
    }), 'utf8');

    // Nothing served the document: the bundle self-hosts a face the gate cannot
    // speak for, which is what every command line run used to report as parity.
    const silent = await harness({ fontsDir });
    const unreviewed = await fetch(`${silent.origin}/api/runs/${silent.runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(unreviewed.report.escalations.join(' ')).toMatch(/Fixture Sans 400 normal/);

    // The same run behind the preview origin `run:release` and `run:fixture` now
    // start: the faces the gate compares are the ones that origin's document
    // declared, read back out of the bytes it served.
    const preview = await startServedPreview(fontsDir);
    cleanups.push(async () => { await preview.close(); });
    // A route the origin does not have serves nothing, so it answers for no face.
    expect((await fetch(`${preview.origin}/preview/v0/`)).status).toBe(404);
    expect(preview.servedFaces('v0')).toBeUndefined();

    const declared = await preview.serve('v0', renderDesign(createFixtureIR()));
    expect(declared.map((face) => face.family)).toEqual(['Fixture Sans']);
    expect(preview.servedFaces('v0')).toEqual(declared);

    const served = await harness({ fontsDir, previewFaces: () => declared });
    const compared = await fetch(`${served.origin}/api/runs/${served.runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(compared.report.parity.matched).toBe(true);
    expect(compared.report.parity.routes.flatMap((route) => route.differences)).toEqual([]);
    expect(compared.report.escalations.join(' ')).not.toMatch(/Fixture Sans|Foundry Grotesk/);

    // One studio origin serves many runs: the faces are recorded per version, so
    // a run whose preview the captain never opened has nothing to compare and
    // the gate says so instead of borrowing another run's document.
    const unopened = await harness({ fontsDir, previewFaces: (version) => preview.servedFaces(version.id) });
    const borrowed = await fetch(`${unopened.origin}/api/runs/${unopened.runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(borrowed.report.escalations.join(' ')).toMatch(/Fixture Sans 400 normal/);

    // The same run once its own document really left the origin.
    const opened = await harness({ fontsDir, previewFaces: (version) => preview.servedFaces(version.id) });
    await preview.serve(opened.stageVersionId, renderDesign(opened.run.releaseContext().current.ir));
    const reviewed = await fetch(`${opened.origin}/api/runs/${opened.runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(reviewed.report.parity.matched).toBe(true);
    expect(reviewed.report.escalations.join(' ')).not.toMatch(/Fixture Sans/);

    // The same served document against a release that ships no face at all: the
    // comparison has two independent sides, so it says the face moved.
    const diverged = await harness({ previewFaces: () => declared });
    const flagged = await fetch(`${diverged.origin}/api/runs/${diverged.runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(flagged.report.parity.matched).toBe(false);
    expect(flagged.report.parity.routes.flatMap((route) => route.differences)).toContain('A face Fixture Sans 400 normal está no preview e não no release.');
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
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'failed', path: 'p', hash: 'h', metrics: { critical: 1, serious: 0 }, notes: ['contraste'] }],
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

  it('publishes the version Gate 3 refined, and that publication is the finalization approval', async () => {
    const edited = 'Prova antes do brilho, revisada na finalização.';
    // An axe run that failed with no critical or serious violation raises a
    // critic finding — so the refiner mints a new version — without a veto.
    const { origin, runId, releaseRoot, run, stageVersionId } = await harness({
      provider: pageEditingProvider(edited),
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'failed', path: 'p', hash: 'h', metrics: { critical: 0, serious: 0 }, notes: ['um ponto a revisar'] }],
    });
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.report.blocked).toBe(false);
    expect(prepared.versionId).not.toBe(stageVersionId);

    const published = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Aceito os pontos em aberto.' }) });
    expect(published.status).toBe(200);
    const snapshot = run.snapshot();
    const approval = snapshot.approvals.find((entry) => entry.stage === 'finalization' && entry.decision === 'approved')!;
    // Publishing is the approval: it names the refined version, and so do the
    // release record and the bytes on disk.
    expect(approval.versionId).toBe(prepared.versionId);
    expect(snapshot.status).toBe('succeeded');
    expect(snapshot.exportManifest!.digest).toBe(prepared.digest);
    const [publication] = await readReleasePublications(releaseRoot, prepared.digest);
    expect(publication?.releasedVersionId).toBe(prepared.versionId);
    expect(publication?.acceptedEscalations).toEqual(prepared.report.escalations);
    expect(await readFile(join(releaseRoot, prepared.digest, 'proof', 'index.html'), 'utf8')).toContain(edited);
  });

  it('has no approve route that could close the finalization gate beside Gate 3', async () => {
    const { origin, runId, releaseRoot, run } = await harness({
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'failed', path: 'p', hash: 'h', metrics: { critical: 1, serious: 0 }, notes: ['contraste'] }],
    });
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.report.vetoes.map((veto) => veto.id)).toContain('CRITICAL_AA_REGRESSION');
    const blocked = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest }) });
    expect(blocked.status).toBe(409);

    const approve = await fetch(`${origin}/api/runs/${runId}/approve`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', stage: 'finalization' }) });
    expect(approve.status).toBe(409);
    expect((await approve.json() as { error: string }).error).toMatch(/Gate 3/);
    expect(run.snapshot().status).toBe('needs_review');
    expect(run.snapshot().approvals.filter((entry) => entry.stage === 'finalization')).toHaveLength(0);
    await expect(readdir(releaseRoot)).rejects.toThrow();
  });

  it('rewinds the rejected finalization proposal even after Gate 3 refined it', async () => {
    const { origin, runId, run, stageVersionId } = await harness({
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'failed', path: 'p', hash: 'h', metrics: { critical: 1, serious: 0 }, notes: ['contraste'] }],
    });
    const prototype = run.snapshot().approvals.find((entry) => entry.stage === 'prototype' && entry.decision === 'approved')!;
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.versionId).not.toBe(stageVersionId);
    expect(run.snapshot().currentVersion.id).toBe(prepared.versionId);

    // The captain rejects the finalization proposal, so the document goes back to
    // what the prototype gate approved, not to the proposal they just refused.
    const rejected = await run.reject('finalization', 'captain');
    expect(rejected.currentVersion.id).toBe(prototype.versionId);
  });

  it('refines the re-produced proposal from a clean gate after the captain rejected the first one', async () => {
    // An axe run that failed without a critical or serious violation raises a
    // critic finding, so the refiner writes the review record without a veto.
    const { origin, runId, run, stageVersionId } = await harness({
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'failed', path: 'p', hash: 'h', metrics: { critical: 0, serious: 0 }, notes: ['um ponto a revisar'] }],
    });
    const first = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(first.report.refinementCycles).toBe(1);

    // The captain rejects, the stage runs again and produces the same document,
    // so the refiner meets the base its discarded run already patched.
    await run.reject('finalization', 'captain');
    await run.runNext();
    expect(run.snapshot().currentVersion.id).toBe(stageVersionId);

    const second = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(second.report.refinementCycles).toBe(1);
    expect(second.versionId).toBe(first.versionId);
    expect(second.report.escalations.join(' ')).not.toMatch(/patch-refiner falhou/);
    expect(second.report.escalations.join(' ')).not.toMatch(/Idempotent patch|Patch overlap/);
  });

  it('refuses to publish a release prepared for the proposal the captain rejected', async () => {
    const { origin, runId, run, releaseRoot } = await harness({
      provider: pageEditingProvider('Prova reescrita na finalização.'),
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'passed', path: 'p', hash: 'h', metrics: { critical: 0, serious: 0 }, notes: [] }],
    });
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.report.blocked).toBe(false);

    // The captain rejects the proposal and the stage runs again, so the document
    // at the gate renders different bytes than the prepared bundle.
    await run.reject('finalization', 'captain');
    await run.runNext();
    expect(run.snapshot().currentVersion.id).not.toBe(prepared.versionId);

    const stale = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Aceito os pontos em aberto.' }) });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: string }).error).toMatch(/prepare o release novamente/);
    await expect(readdir(releaseRoot)).rejects.toThrow();
    expect(run.snapshot().status).toBe('needs_review');
    expect(run.snapshot().approvals.filter((entry) => entry.stage === 'finalization' && entry.decision === 'approved')).toHaveLength(0);

    // Preparing again compiles the proposal now at the gate, and the bundle, the
    // release record and the approval all name that one document.
    const again = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(again.digest).not.toBe(prepared.digest);
    const published = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: again.digest, rationale: 'Aceito os pontos em aberto.' }) });
    expect(published.status).toBe(200);
    expect((await readdir(releaseRoot)).filter((entry) => !entry.endsWith('.json'))).toEqual([again.digest]);
    const approval = run.snapshot().approvals.find((entry) => entry.stage === 'finalization' && entry.decision === 'approved')!;
    expect(approval.versionId).toBe(again.versionId);
    const [publication] = await readReleasePublications(releaseRoot, again.digest);
    expect(publication?.releasedVersionId).toBe(again.versionId);
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
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: string }).error).toMatch(/aprovou o bundle/);
    await expect(readdir(releaseRoot)).rejects.toThrow();
  });

  it('refuses to publish while a veto stands, and leaves nothing on disk', async () => {
    const { origin, runId, releaseRoot } = await harness({
      evidence: [{ id: 'axe-home', runner: 'axe', engine: 'chromium', route: '/', state: 'default', status: 'failed', path: 'p', hash: 'h', metrics: { critical: 1, serious: 0 }, notes: ['contrast'] }],
    });
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    expect(prepared.report.blocked).toBe(true);
    expect(prepared.report.vetoes.map((veto) => veto.id)).toContain('CRITICAL_AA_REGRESSION');
    const blocked = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest }) });
    expect(blocked.status).toBe(409);
    expect((await blocked.json() as { error: string }).error).toMatch(/CRITICAL_AA_REGRESSION/);
    await expect(readdir(releaseRoot)).rejects.toThrow();
  });

  it('leaves no bundle and no acceptance when the publication cannot be recorded', async () => {
    const { origin, runId, releaseRoot, run, repository } = await harness();
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    // The release record beside the bundle is damaged, so this publication
    // cannot be written into it. The record is part of the acceptance, so
    // nothing is accepted: the bytes go away again and the damaged file is left
    // exactly as it was rather than being replaced by a publish that failed.
    await mkdir(releaseRoot, { recursive: true });
    const recordPath = join(releaseRoot, `${prepared.digest}.publications.json`);
    await writeFile(recordPath, '[{"digest":', 'utf8');
    const refused = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Aceito os pontos em aberto.' }) });
    expect(refused.status).toBe(500);
    expect((await refused.json() as { error: string }).error).toMatch(/unreadable/);
    expect(await readdir(releaseRoot)).toEqual([`${prepared.digest}.publications.json`]);
    expect(await readFile(recordPath, 'utf8')).toBe('[{"digest":');
    expect(run.snapshot().status).toBe('needs_review');
    expect(run.snapshot().exportManifest).toBeUndefined();
    expect(await repository.listApprovals(runId)).toHaveLength(2);
    expect(run.releaseSnapshot()?.published).toBeUndefined();

    // Repairing the record publishes the same bundle, bytes, acceptance and
    // record together, and the retry records one publication.
    await rm(recordPath, { force: true });
    const published = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Aceito os pontos em aberto.' }) });
    expect(published.status).toBe(200);
    expect(await readdir(join(releaseRoot, prepared.digest))).toContain('manifest.json');
    expect(await readReleasePublications(releaseRoot, prepared.digest)).toHaveLength(1);
  });

  it('takes the publication back out of the record when the acceptance does not commit', async () => {
    const { origin, runId, releaseRoot, run, repository, db } = await harness();
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    // The publication is written inside the acceptance, before it commits. Here
    // the event log refuses the event that says the run finished, so the
    // transaction rolls back and the entry the publish had already appended is
    // taken back with the bundle.
    db.sqlite.exec("CREATE TRIGGER refuse_finish BEFORE INSERT ON events WHEN NEW.type = 'run.finished' BEGIN SELECT RAISE(ABORT, 'the event log is unavailable'); END;");
    const refused = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Aceito os pontos em aberto.' }) });
    expect(refused.status).toBe(500);
    expect((await refused.json() as { error: string }).error).toMatch(/event log is unavailable/);
    // The entry was written and taken back: the record exists and holds no
    // publication, where a publish that never reached it leaves no record at all.
    expect(await readdir(releaseRoot)).toEqual([`${prepared.digest}.publications.json`]);
    expect(await readReleasePublications(releaseRoot, prepared.digest)).toEqual([]);
    expect(run.snapshot().status).toBe('needs_review');
    expect(run.snapshot().exportManifest).toBeUndefined();
    expect(await repository.listApprovals(runId)).toHaveLength(2);

    // A server restarted here reads the same run the live one reports: still at
    // Gate 3, with no release behind it.
    const restored = new FixtureRun({ repository, provider: new FakeModelProvider() });
    expect(await restored.restore(runId)).toBe(true);
    expect(restored.snapshot().status).not.toBe('succeeded');
    expect(restored.snapshot().exportManifest).toBeUndefined();

    // With the log writable again the same bundle publishes, and the record
    // holds that one publication rather than the retry's second copy.
    db.sqlite.exec('DROP TRIGGER refuse_finish');
    const published = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Aceito os pontos em aberto.' }) });
    expect(published.status).toBe(200);
    expect(run.snapshot().status).toBe('succeeded');
    expect(await readdir(join(releaseRoot, prepared.digest))).toContain('manifest.json');
    expect(await readReleasePublications(releaseRoot, prepared.digest)).toHaveLength(1);
    const afterPublish = new FixtureRun({ repository, provider: new FakeModelProvider() });
    expect(await afterPublish.restore(runId)).toBe(true);
    expect(afterPublish.snapshot().status).toBe('succeeded');
  });

  it('refuses a publish whose document the linter rejects, and says so as a conflict', async () => {
    const { origin, runId, run } = await harness();
    const prepared = await fetch(`${origin}/api/runs/${runId}/release`, { method: 'POST', headers: studio }).then((response) => response.json() as Promise<ReleaseSnapshot>);
    // The document at the gate stops passing the linter: a node takes a raw
    // visual value instead of a token. No gate closes over that, and the Studio
    // reads it as the state conflict it is rather than as a broken server.
    run.releaseContext().current.ir.pages.routes[0]!.nodes[0]!.props.color = '#ff00ff';
    const refused = await fetch(`${origin}/api/runs/${runId}/release/publish`, { method: 'POST', headers: studio, body: JSON.stringify({ approverRole: 'captain', digest: prepared.digest, rationale: 'Aceito os pontos em aberto.' }) });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toMatch(/lint error/);
    expect(run.snapshot().status).toBe('needs_review');
  });

  it('has no release routes when the server does not serve the finalization stage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-release-off-'));
    const db = openDatabase(join(dir, 'api.sqlite'));
    const runs = new Map<string, FixtureRun>();
    const server = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ modelProvider: 'fake', repository: new ProjectRepository(db), provider: new FakeModelProvider() }); await run.initialize(id); runs.set(id, run); return run; } });
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
