import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, type AgentTask, type DesignIR, type EvidenceArtifact, type ReleaseCritique, type ReleaseFinding } from '@pwb/domain';
import { compileRelease, parseFontFaceCss, type CompiledSite, type ServedFace } from '@pwb/export';
import { Applier, PatchGate, Scheduler, VersionStore } from '@pwb/orchestrator';
import { CodexJsonRunner, type CodexExecutor } from '@pwb/providers';
import { renderDesign } from '@pwb/renderer';
import {
  aggregateVetoes, checkPreviewReleaseParity, ClaudeReleaseCriticProvider, createReleaseHarness, criticTasks, DeterministicReleaseSummarizer,
  evaluateReleaseGate, evidenceCoverage, evidenceVetoes, FakeReleaseCriticProvider, FakeReleaseRefiner, FinalizationStage,
  partitionEvidence, PatchRefiner, readEvidence, RELEASE_CRITICS, sealSummary, unreviewedFaces, VETO_CATALOG, writeEvidenceArtifact,
  type ReleaseCriticProvider, type ReleaseRefinerProvider, type ReleaseSummarizerProvider,
} from './index.js';

const COMPILER_OPTIONS = { siteUrl: 'https://oficina.example', siteName: 'Oficina' };
/**
 * The release the stage evaluates, and so the one every artifact here says it
 * measured unless it says otherwise. It comes from a version the Applier
 * created, because the schema normalizes the document on the way in and the
 * normalized form is what the stage compiles.
 */
const STAGE_RELEASE = (() => {
  const version = new Applier(new VersionStore(), new PatchGate()).createRoot(createFixtureIR());
  return compileRelease(renderDesign(version.ir), version.ir, COMPILER_OPTIONS);
})();

function compiledFixture(mutate?: (ir: DesignIR) => void) {
  const ir = createFixtureIR();
  mutate?.(ir);
  return { ir, compiled: compileRelease(renderDesign(ir), ir, COMPILER_OPTIONS) };
}

/** The fixture showing the mark it declares, so an unlicensed asset is bytes the bundle ships. */
function withInlinedMark(ir: DesignIR): void {
  const home = ir.pages.routes[0]!;
  home.nodes.find((node) => node.id === 'home-root')!.slots.children!.push('home-mark');
  home.nodes.push({ id: 'home-mark', kind: 'media', semantic: 'figure', props: { text: 'Marca da oficina' }, slots: {}, assetId: 'fixture-mark', responsive: [] });
}

const FIXTURE_FACE = {
  family: 'Fixture Sans', weight: '400', style: 'normal' as const, format: 'woff2' as const,
  bytes: new Uint8Array([119, 79, 70, 50, 4, 3, 2, 1]),
  license: 'ofl-1.1', source: 'https://fonts.example/fixture-sans', author: 'Fixture Foundry', date: '2026-09-07',
};

function compiledWithFace() {
  const ir = createFixtureIR();
  return { ir, compiled: compileRelease(renderDesign(ir), ir, { ...COMPILER_OPTIONS, fonts: [FIXTURE_FACE] }) };
}

/**
 * The faces a view's document declared, read back out of its stylesheet the way
 * the preview origin reads back the bytes it served: the two sides of the
 * comparison never come from the same object.
 */
function servedFaces(compiled: CompiledSite): ServedFace[] {
  const stylesheet = compiled.files.find((file) => file.path === compiled.stylesheetPath)!;
  return parseFontFaceCss(stylesheet.contents as string, (url) => `assets/${url}`);
}

function artifact(overrides: Partial<EvidenceArtifact> & Pick<EvidenceArtifact, 'id' | 'runner' | 'engine'>): EvidenceArtifact {
  return {
    route: '/', state: 'default', status: 'passed', path: `${overrides.id}.json`, hash: 'hash', metrics: {}, notes: [],
    releaseDigest: STAGE_RELEASE.digest, irHash: STAGE_RELEASE.irHash, ...overrides,
  };
}

function pageIds(ir: DesignIR): Map<string, string> {
  return new Map(ir.pages.routes.map((page) => [page.route, page.id]));
}

describe('release veto catalogue', () => {
  it('names every veto the plan fixes, once each', () => {
    expect(VETO_CATALOG.map((definition) => definition.id).sort()).toEqual([
      'ASSET_WITHOUT_LICENSE', 'BROKEN_PRIMARY_LINK', 'BUILD_FAILED', 'CRITICAL_AA_REGRESSION',
      'RELEASE_DIVERGES_FROM_APPROVED', 'SECRET_IN_BUNDLE', 'UNSANITIZED_HTML', 'XSS_OR_JAVASCRIPT_URL',
    ]);
  });

  it('refuses a veto raised by something that is not allowed to raise it', () => {
    expect(() => aggregateVetoes([{ id: 'SECRET_IN_BUNDLE', detector: 'evidence', where: 'x', detail: 'y' }])).toThrow(/may only be raised by compiler/);
  });

  it('merges duplicates and orders the report the same way every time', () => {
    const one = { id: 'BUILD_FAILED' as const, detector: 'compiler' as const, where: '/b', detail: 'd' };
    const two = { id: 'SECRET_IN_BUNDLE' as const, detector: 'compiler' as const, where: '/a', detail: 'd' };
    expect(aggregateVetoes([one, two], [one]).map((veto) => veto.id)).toEqual(['SECRET_IN_BUNDLE', 'BUILD_FAILED']);
  });
});

describe('independent evidence', () => {
  it('derives an accessibility regression from raw axe counts even when the runner declared none', () => {
    const vetoes = evidenceVetoes([artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium', metrics: { critical: 1, serious: 0 } })]);
    expect(vetoes.map((veto) => veto.id)).toEqual(['CRITICAL_AA_REGRESSION']);
    expect(vetoes[0]!.detector).toBe('evidence');
  });

  it('treats a failed browser or unit run as a build failure', () => {
    expect(evidenceVetoes([artifact({ id: 'pw-webkit', runner: 'playwright', engine: 'webkit', status: 'failed', notes: ['overflow at 360px'] })])[0])
      .toMatchObject({ id: 'BUILD_FAILED', detector: 'evidence', detail: 'overflow at 360px' });
  });

  it('keeps a clean run clean', () => {
    expect(evidenceVetoes([artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium', metrics: { critical: 0, serious: 0, moderate: 3 } })])).toEqual([]);
  });

  it('does not let a browser scan stand in for a Playwright run on that engine', () => {
    const coverage = evidenceCoverage([artifact({ id: 'axe', runner: 'axe', engine: 'chromium' })]);
    expect(coverage.engines).toEqual([]);
    expect(coverage.missing.join(' ')).toMatch(/Playwright em chromium/);
  });

  it('says out loud when a runner ran and failed instead of counting it as coverage', () => {
    const coverage = evidenceCoverage([artifact({ id: 'lh-home', runner: 'lighthouse', engine: 'chromium', status: 'failed', notes: ['NO_FCP: a página não pintou'] })]);
    expect(coverage.missing.join(' ')).toMatch(/NO_FCP/);
  });

  it('names every runner and engine that produced no evidence', () => {
    const coverage = evidenceCoverage([artifact({ id: 'a', runner: 'axe', engine: 'chromium' })]);
    expect(coverage.missing.join(' ')).toMatch(/vitest/);
    expect(coverage.missing.join(' ')).toMatch(/firefox/);
    expect(coverage.missing.join(' ')).toMatch(/webkit/);
    expect(coverage.missing.join(' ')).toMatch(/lighthouse/);
  });

  it('sets aside an artifact measured against another release instead of crediting it', () => {
    const partition = partitionEvidence([
      artifact({ id: 'pw-chromium', runner: 'playwright', engine: 'chromium' }),
      artifact({ id: 'pw-firefox-antigo', runner: 'playwright', engine: 'firefox', releaseDigest: 'digest-de-outra-execucao' }),
    ], { digest: STAGE_RELEASE.digest, irHash: STAGE_RELEASE.irHash });
    expect(partition.credited.map((entry) => entry.id)).toEqual(['pw-chromium']);
    expect(partition.escalations.join(' ')).toMatch(/pw-firefox-antigo.*não conta como cobertura/);
  });

  it('credits a measurement of the same bytes taken from another document, and says so', () => {
    const partition = partitionEvidence([artifact({ id: 'pw-chromium', runner: 'playwright', engine: 'chromium', irHash: 'documento-anterior' })], { digest: STAGE_RELEASE.digest, irHash: STAGE_RELEASE.irHash });
    expect(partition.credited.map((entry) => entry.id)).toEqual(['pw-chromium']);
    expect(partition.escalations.join(' ')).toMatch(/mediu estes mesmos bytes a partir do documento/);
  });

  it('round-trips artifacts through the directory the gate reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pwb-evidence-'));
    try {
      await writeEvidenceArtifact(root, artifact({ id: 'axe/home:1440', runner: 'axe', engine: 'firefox' }));
      const [loaded] = await readEvidence(root);
      expect(loaded?.id).toBe('axe/home:1440');
      expect(await readEvidence(join(root, 'absent'))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('preview and release parity', () => {
  it('matches the preview the captain reviewed, route by route', () => {
    const { ir, compiled } = compiledFixture();
    const report = checkPreviewReleaseParity(renderDesign(ir), compiled, pageIds(ir));
    expect(report.matched).toBe(true);
    expect(report.routes.map((route) => route.route)).toEqual(['/', '/proof', '/contact']);
  });

  it('catches a release whose stylesheet no longer resolves what the preview showed', () => {
    const { ir, compiled } = compiledFixture();
    const stylesheet = compiled.files.find((file) => file.path === compiled.stylesheetPath)!;
    stylesheet.contents = (stylesheet.contents as string).replace('[data-node-id="home-title"] {', '[data-node-id="home-title"] { opacity: 0;');
    const report = checkPreviewReleaseParity(renderDesign(ir), compiled, pageIds(ir));
    expect(report.matched).toBe(false);
    expect(report.routes.find((route) => route.route === '/')?.differences.join(' ')).toMatch(/home-title/);
  });

  it('catches a release whose text drifted from the preview', () => {
    const { ir, compiled } = compiledFixture();
    const home = compiled.files.find((file) => file.path === 'index.html')!;
    home.contents = (home.contents as string).replace('Toda escolha tem motivo.', 'Outra coisa.');
    expect(checkPreviewReleaseParity(renderDesign(ir), compiled, pageIds(ir)).matched).toBe(false);
  });

  it('reports identical routes when the preview served the faces the release ships', () => {
    const { ir, compiled } = compiledWithFace();
    expect(checkPreviewReleaseParity(renderDesign(ir), compiled, pageIds(ir), servedFaces(compiled)).matched).toBe(true);
  });

  it('names the self-hosted faces no preview ever compared', () => {
    const { compiled } = compiledWithFace();
    expect(unreviewedFaces(compiled, servedFaces(compiled))).toEqual([]);
    expect(unreviewedFaces(compiled)).toEqual(['Fixture Sans 400 normal']);
    // A bundle that self-hosts nothing has no face to report as unreviewed.
    expect(unreviewedFaces(compiledFixture().compiled)).toEqual([]);
  });

  it('catches a release that ships a face the preview never served', () => {
    const { ir, compiled } = compiledWithFace();
    // The face the captain was served before the file behind it was replaced.
    const served = servedFaces(compiled).map((face) => ({ ...face, path: 'assets/fonts/fixture-sans-400-normal.000000000000.woff2' }));
    const report = checkPreviewReleaseParity(renderDesign(ir), compiled, pageIds(ir), served);
    expect(report.matched).toBe(false);
    for (const route of report.routes) expect(route.differences.join(' ')).toMatch(/A face Fixture Sans 400 normal tem arquivos diferentes/);
  });
});

describe('five read-only release critics', () => {
  function context() {
    const { ir, compiled } = compiledFixture();
    return { ir, compiled, tasks: criticTasks({ runId: 'run-1', baseVersionId: 'v0', ir, compiled, evidence: [artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium' })], attempt: 1, promptVersion: 'phase3-v1', modelAlias: 'claude-local' }) };
  }

  it('builds one separate task per dimension', () => {
    const { tasks } = context();
    expect(tasks).toHaveLength(5);
    expect(tasks.map((entry) => entry.definition.dimension).sort()).toEqual(['accessibility', 'asset-performance', 'provenance-security', 'semantics-seo', 'visual-regression']);
    expect(new Set(tasks.map((entry) => entry.task.id)).size).toBe(5);
  });

  it('gives no critic a writable path, so the patch gate would refuse anything it tried to touch', () => {
    const { tasks } = context();
    const gate = new PatchGate();
    for (const { task } of tasks) {
      expect(task.allowedPaths).toEqual([]);
      expect(() => gate.validate({
        operations: [{ op: 'replace', path: '/reviewRecord/findings', value: [] }],
        baseVersionId: 'v0', touchedPaths: ['/reviewRecord/findings'], rationale: 'critic overreach', confidence: 1,
        stage: 'finalization', role: 'compiler', idempotencyKey: 'k',
      }, { currentVersionId: 'v0', allowedPaths: task.allowedPaths, stage: task.stage, role: task.role })).toThrow(/not allowed/);
    }
  });

  it('shows each critic only the evidence its dimension may reason from', () => {
    const { tasks } = context();
    const accessibility = tasks.find((entry) => entry.definition.dimension === 'accessibility')!;
    const seo = tasks.find((entry) => entry.definition.dimension === 'semantics-seo')!;
    expect((accessibility.task.documentSlice['/evidence'] as EvidenceArtifact[]).map((entry) => entry.id)).toEqual(['axe-home']);
    expect(seo.task.documentSlice['/evidence']).toEqual([]);
    expect(accessibility.task.documentSlice['/identity']).toBeDefined();
  });

  it('re-stamps the identity of a critique so a session cannot report as another critic', async () => {
    const { tasks } = context();
    const definition = RELEASE_CRITICS.find((critic) => critic.dimension === 'accessibility')!;
    const lying: ReleaseCritique = { taskId: 'someone-else', dimension: 'asset-performance', verdict: 'pass', rubricScore: 4, summary: 'ok', findings: [] };
    const provider = new ClaudeReleaseCriticProvider({ run: async () => lying });
    const critique = await provider.critique(tasks[0]!.task, definition);
    expect(critique.taskId).toBe(tasks[0]!.task.id);
    expect(critique.dimension).toBe('accessibility');
  });

  it('corrects one malformed Codex response before validating the finalization result', async () => {
    const { tasks } = context();
    const entry = tasks.find((candidate) => candidate.definition.dimension === 'accessibility')!;
    const prompts: string[] = [];
    const runner = new CodexJsonRunner({
      execute: async (_executable, args) => {
        prompts.push(args.at(-1)!);
        const text = prompts.length === 1
          ? 'not-json'
          : JSON.stringify({ taskId: entry.task.id, dimension: entry.definition.dimension, verdict: 'pass', rubricScore: 4, summary: 'ok', findings: [] });
        return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`, stderr: '' };
      },
    });
    const critique = await new ClaudeReleaseCriticProvider(runner).critique(entry.task, entry.definition);
    expect(critique).toMatchObject({ taskId: entry.task.id, dimension: 'accessibility', verdict: 'pass' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Correct the previous schema violation');
  });

  it('reports what the evidence shows and stays silent about what it does not', async () => {
    const { tasks } = context();
    const provider = new FakeReleaseCriticProvider();
    const accessibility = tasks.find((entry) => entry.definition.dimension === 'accessibility')!;
    expect((await provider.critique(accessibility.task, accessibility.definition)).findings).toEqual([]);
    const performance = tasks.find((entry) => entry.definition.dimension === 'asset-performance')!;
    const critique = await provider.critique(performance.task, performance.definition);
    expect(critique.findings.map((finding) => finding.severity)).toContain('uncertain');
    expect(critique.verdict).toBe('uncertain');
  });
});

describe('patch refiner', () => {
  const refiner = new PatchRefiner(new FakeReleaseRefiner());
  const finding = (id: string, severity: ReleaseFinding['severity'] = 'error'): ReleaseFinding => ({ id, severity, route: '/', evidenceRef: 'e', cause: 'c', suggestion: { kind: 'token', path: '/pages', note: 'n' } });

  it('stops as soon as no error finding is left', () => {
    expect(refiner.decide(0, [finding('a', 'warning')], [])).toMatchObject({ action: 'stop' });
  });

  it('refines while there is something to fix and cycles remain', () => {
    expect(refiner.decide(0, [finding('a')], [])).toEqual({ action: 'refine', findingIds: ['a'] });
    expect(refiner.decide(1, [finding('b')], ['a'])).toEqual({ action: 'refine', findingIds: ['b'] });
  });

  it('never runs a third cycle', () => {
    const decision = refiner.decide(2, [finding('a')], ['b']);
    expect(decision).toMatchObject({ action: 'stop' });
    expect(decision.action === 'stop' && decision.reason).toMatch(/limite de 2 ciclos/);
  });

  it('escalates instead of trying the same finding a second time', () => {
    const decision = refiner.decide(1, [finding('a')], ['a']);
    expect(decision).toMatchObject({ action: 'stop' });
    expect(decision.action === 'stop' && decision.escalations.join(' ')).toMatch(/repetiu em duas rodadas/);
  });

  it('produces a patch the finalization patch gate accepts, confined to the review record', async () => {
    const task = { baseVersionId: 'v0', inputDigest: 'digest', stage: 'finalization', role: 'compiler', allowedPaths: ['/reviewRecord'], documentSlice: { '/reviewRecord': { findings: ['old'], approvals: [] } } } as unknown as AgentTask;
    const patch = await new FakeReleaseRefiner().refine(task, [finding('a')]);
    expect(patch?.touchedPaths).toEqual(['/reviewRecord/findings']);
    // The stage pins its role, so the refiner's proposal declares it.
    expect(patch?.role).toBe('compiler');
    expect(patch?.stage).toBe('finalization');
    expect(patch?.operations[0]?.value).toEqual(['a: c', 'old']);
    expect(() => new PatchGate().validate(patch!, { currentVersionId: 'v0', allowedPaths: task.allowedPaths, stage: task.stage, role: task.role })).not.toThrow();
  });
});

describe('release summarizer has no gate authority', () => {
  const veto = { id: 'SECRET_IN_BUNDLE' as const, detector: 'compiler' as const, where: 'index.html', detail: 'a key' };

  it('rewrites a summary that under-reports the vetoes', () => {
    const sealed = sealSummary({ headline: 'tudo certo', highlights: [], openQuestions: [], vetoCount: 0, gateAuthority: 'none' }, [veto]);
    expect(sealed.vetoCount).toBe(1);
    expect(sealed.openQuestions.join(' ')).toMatch(/Segredo no bundle/);
  });

  it('leads with the block when one stands', async () => {
    const summary = await new DeterministicReleaseSummarizer().summarize({ bundleDigest: 'abcdef0123456789', vetoes: [veto], critiques: [], escalations: [] });
    expect(summary.headline).toMatch(/bloqueado por 1 veto/);
    expect(summary.gateAuthority).toBe('none');
  });
});

describe('Gate 3', () => {
  function gateInput(overrides: Partial<Parameters<typeof evaluateReleaseGate>[0]> = {}) {
    const { ir, compiled } = compiledFixture();
    const critiques: ReleaseCritique[] = RELEASE_CRITICS.map((critic) => ({ taskId: critic.taskId, dimension: critic.dimension, verdict: 'pass', rubricScore: 4, summary: 'ok', findings: [] }));
    return {
      compiled, critiques, evidence: [] as EvidenceArtifact[],
      parity: checkPreviewReleaseParity(renderDesign(ir), compiled, pageIds(ir)),
      approved: { versionId: 'v-approved', irHash: compiled.irHash, renderedFiles: compiled.files.map((file) => [file.path, file.hash] as [string, string]) },
      releasedVersionId: 'v-approved',
      refinementCycles: 0, escalations: [] as string[], ...overrides,
    };
  }

  it('clears a release with no veto and leaves the decision to the captain', () => {
    const report = evaluateReleaseGate(gateInput());
    expect(report.blocked).toBe(false);
    expect(report.vetoes).toEqual([]);
    expect(report.approverRole).toBe('captain');
    expect(report.rubric).toHaveLength(5);
  });

  it('blocks on a veto the compiler found', () => {
    const { ir } = compiledFixture(withInlinedMark);
    ir.assets.items[0]!.provenance.license = '';
    const compiled = compileRelease(renderDesign(ir), ir, COMPILER_OPTIONS);
    const report = evaluateReleaseGate(gateInput({
      compiled,
      approved: { versionId: 'v', irHash: compiled.irHash, renderedFiles: compiled.files.map((file) => [file.path, file.hash] as [string, string]) },
      parity: checkPreviewReleaseParity(renderDesign(ir), compiled, pageIds(ir)),
    }));
    expect(report.blocked).toBe(true);
    expect(report.vetoes.map((entry) => entry.id)).toContain('ASSET_WITHOUT_LICENSE');
  });

  it('blocks when the release would publish something other than what was approved', () => {
    const approvedIr = createFixtureIR();
    approvedIr.pages.routes[0]!.nodes.find((node) => node.id === 'home-title')!.props.text = 'Outro título aprovado.';
    const approvedCompile = compileRelease(renderDesign(approvedIr), approvedIr, COMPILER_OPTIONS);
    const report = evaluateReleaseGate(gateInput({
      approved: { versionId: 'v-approved', irHash: approvedCompile.irHash, renderedFiles: approvedCompile.files.map((file) => [file.path, file.hash] as [string, string]) },
    }));
    const divergence = report.vetoes.find((entry) => entry.id === 'RELEASE_DIVERGES_FROM_APPROVED');
    expect(divergence?.detail).toContain('index.html');
    expect(report.blocked).toBe(true);
  });

  it('treats a refinement that only records findings as no divergence at all', () => {
    const { ir } = compiledFixture();
    const refined = createFixtureIR();
    refined.reviewRecord.findings = ['accessibility:axe-home: contraste insuficiente'];
    const refinedCompile = compileRelease(renderDesign(refined), refined, COMPILER_OPTIONS);
    const approvedCompile = compileRelease(renderDesign(ir), ir, COMPILER_OPTIONS);
    const report = evaluateReleaseGate(gateInput({
      compiled: refinedCompile,
      approved: { versionId: 'v-approved', irHash: approvedCompile.irHash, renderedFiles: approvedCompile.files.map((file) => [file.path, file.hash] as [string, string]) },
      releasedVersionId: 'v-refined',
      refinementCycles: 1,
      parity: checkPreviewReleaseParity(renderDesign(refined), refinedCompile, pageIds(refined)),
    }));
    expect(report.vetoes).toEqual([]);
    expect(report.blocked).toBe(false);
    expect(report.approvedVersionId).toBe('v-approved');
    expect(report.releasedVersionId).toBe('v-refined');
    expect(report.escalations.join(' ')).toMatch(/patch-refiner produziu a versão v-refined/);
  });

  it('does not credit a veto raised by an artifact measured against another release', () => {
    const stale = artifact({ id: 'axe-antigo', runner: 'axe', engine: 'chromium', status: 'failed', metrics: { critical: 3, serious: 1 }, releaseDigest: 'digest-de-outra-execucao' });
    const report = evaluateReleaseGate(gateInput({ evidence: [stale] }));
    expect(report.vetoes).toEqual([]);
    expect(report.evidence).toEqual([]);
    expect(report.escalations.join(' ')).toMatch(/axe-antigo.*não conta como cobertura/);
  });

  it('escalates an unbundled asset without terms instead of blocking on it', () => {
    const { ir } = compiledFixture(withInlinedMark);
    ir.assets.items[0]!.status = 'placeholder';
    ir.assets.items[0]!.provenance.license = 'pending provider terms';
    const compiled = compileRelease(renderDesign(ir), ir, COMPILER_OPTIONS);
    const report = evaluateReleaseGate(gateInput({
      compiled,
      approved: { versionId: 'v', irHash: compiled.irHash, renderedFiles: compiled.files.map((file) => [file.path, file.hash] as [string, string]) },
      parity: checkPreviewReleaseParity(renderDesign(ir), compiled, pageIds(ir)),
    }));
    expect(report.vetoes.map((entry) => entry.id)).not.toContain('ASSET_WITHOUT_LICENSE');
    expect(report.blocked).toBe(false);
    expect(report.escalations.join(' ')).toMatch(/does not clear it for release/);
  });

  it('still blocks when the bundle ships an asset without terms', () => {
    const { ir } = compiledFixture(withInlinedMark);
    ir.assets.items[0]!.provenance.license = 'pending provider terms';
    const compiled = compileRelease(renderDesign(ir), ir, COMPILER_OPTIONS);
    const report = evaluateReleaseGate(gateInput({
      compiled,
      approved: { versionId: 'v', irHash: compiled.irHash, renderedFiles: compiled.files.map((file) => [file.path, file.hash] as [string, string]) },
      parity: checkPreviewReleaseParity(renderDesign(ir), compiled, pageIds(ir)),
    }));
    expect(report.vetoes.map((entry) => entry.id)).toContain('ASSET_WITHOUT_LICENSE');
  });

  it('blocks when the release stops matching the preview', () => {
    const input = gateInput();
    input.parity = { matched: false, routes: [{ route: '/', matched: false, differences: ['o nó home-title mudou'] }] };
    expect(evaluateReleaseGate(input).vetoes.map((entry) => entry.id)).toContain('RELEASE_DIVERGES_FROM_APPROVED');
  });

  it('lets no critic and no summary introduce or hide a veto', () => {
    const shouting: ReleaseCritique[] = RELEASE_CRITICS.map((critic) => ({ taskId: critic.taskId, dimension: critic.dimension, verdict: 'revise', rubricScore: 0, summary: 'tudo errado', findings: [{ id: 'x', severity: 'error', route: '/', evidenceRef: 'e', cause: 'c', suggestion: { kind: 'token', path: '/pages', note: 'n' } }] }));
    expect(evaluateReleaseGate(gateInput({ critiques: shouting })).vetoes).toEqual([]);

    const { ir } = compiledFixture(withInlinedMark);
    ir.assets.items[0]!.provenance.license = '';
    const compiled = compileRelease(renderDesign(ir), ir, COMPILER_OPTIONS);
    const lying = { headline: 'tudo certo', highlights: [], openQuestions: [], vetoCount: 0, gateAuthority: 'none' as const };
    const report = evaluateReleaseGate(gateInput({ compiled, approved: { versionId: 'v', irHash: compiled.irHash, renderedFiles: compiled.files.map((file) => [file.path, file.hash] as [string, string]) }, parity: { matched: true, routes: [] }, summary: lying }));
    expect(report.blocked).toBe(true);
    expect(report.summary?.vetoCount).toBe(0);
    expect(report.vetoes.length).toBeGreaterThan(0);
  });

  it('escalates a rubric below the minimum without turning it into a veto', () => {
    const weak: ReleaseCritique[] = RELEASE_CRITICS.map((critic) => ({ taskId: critic.taskId, dimension: critic.dimension, verdict: 'revise', rubricScore: 2, summary: 'fraco', findings: [] }));
    const report = evaluateReleaseGate(gateInput({ critiques: weak }));
    expect(report.blocked).toBe(false);
    expect(report.escalations.join(' ')).toMatch(/abaixo do mínimo 3/);
  });

  it('says out loud when a critic never reported', () => {
    const report = evaluateReleaseGate(gateInput({ critiques: [] }));
    expect(report.escalations.filter((line) => line.includes('não entregou parecer'))).toHaveLength(5);
  });
});

describe('the harness the evidence runners measure', () => {
  const FACE = {
    family: 'Fixture Sans', weight: '400', style: 'normal' as const, format: 'woff2' as const,
    bytes: new Uint8Array([119, 79, 70, 50, 5, 6, 7, 8]),
    license: 'ofl-1.1', source: 'https://fonts.example/fixture-sans', author: 'Fixture Foundry', date: '2026-09-07',
  };

  it('shows the preview the same faces the release ships, from the same files', async () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    const compiled = compileRelease(rendered, ir, { ...COMPILER_OPTIONS, fonts: [FACE] });
    const harness = createReleaseHarness(compiled, rendered, 0);
    const origin = await harness.start();
    try {
      const preview = await (await fetch(`${origin}/preview/`)).text();
      const href = /src:url\("([^"]+)"\)/.exec(preview)?.[1];
      expect(href).toMatch(/^\/assets\/fonts\/fixture-sans-400-normal\.[0-9a-f]{12}\.woff2$/);
      const face = await fetch(`${origin}${href!}`);
      expect(face.status).toBe(200);
      expect(new Uint8Array(await face.arrayBuffer())).toEqual(FACE.bytes);
      // The parity runner asks both sides about exactly these faces.
      const description = await (await fetch(`${origin}/harness.json`)).json() as { fonts: unknown };
      expect(description.fonts).toEqual([{ family: 'Fixture Sans', weight: '400', style: 'normal' }]);
    } finally { await harness.close(); }
  });

  it('leaves the preview byte-identical to the renderer when the project self-hosts nothing', async () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    const harness = createReleaseHarness(compileRelease(rendered, ir, COMPILER_OPTIONS), rendered, 0);
    const origin = await harness.start();
    try {
      expect(await (await fetch(`${origin}/preview/`)).text()).toBe(rendered.routes.find((route) => route.route === '/')!.html);
    } finally { await harness.close(); }
  });
});

describe('the finalization stage end to end with the deterministic providers', () => {
  function stageFor(evidence: EvidenceArtifact[], scheduler?: Scheduler, criticProvider: ReleaseCriticProvider = new FakeReleaseCriticProvider()) {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const version = applier.createRoot(createFixtureIR());
    const stage = new FinalizationStage({ modelAlias: 'fake',
      criticProvider,
      refiner: new PatchRefiner(new FakeReleaseRefiner()),
      compilerOptions: COMPILER_OPTIONS,
      ...(scheduler ? { scheduler } : {}),
    });
    return { stage, applier, version, evidence };
  }

  it('compiles, critiques, and stops at an unblocked gate when nothing is wrong', async () => {
    const { stage, applier, version, evidence } = stageFor([
      artifact({ id: 'vitest', runner: 'vitest', engine: 'node' }),
      artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium' }),
      artifact({ id: 'pw-chromium', runner: 'playwright', engine: 'chromium' }),
      artifact({ id: 'pw-firefox', runner: 'playwright', engine: 'firefox' }),
      artifact({ id: 'pw-webkit', runner: 'playwright', engine: 'webkit' }),
      artifact({ id: 'lh-mobile', runner: 'lighthouse', engine: 'chromium', metrics: { performance: 0.98 } }),
    ]);
    const result = await stage.run({ runId: 'run-clean', version, evidence, applier });
    expect(result.report.blocked).toBe(false);
    expect(result.cycles).toBe(0);
    expect(result.critiques).toHaveLength(5);
    expect(result.report.parity.matched).toBe(true);
    expect(result.report.summary?.gateAuthority).toBe('none');
    expect(result.report.escalations).toEqual([]);
  });

  it('escalates the faces it publishes when no preview served the document', async () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const version = applier.createRoot(createFixtureIR());
    const stage = new FinalizationStage({
      modelAlias: 'fake',
      criticProvider: new FakeReleaseCriticProvider(),
      refiner: new PatchRefiner(new FakeReleaseRefiner()),
      compilerOptions: { ...COMPILER_OPTIONS, fonts: [FIXTURE_FACE] },
    });
    // The bundle carries a face, so the evidence has to name that release.
    const faced = stage.compile(version.ir);
    const measured = { releaseDigest: faced.digest, irHash: faced.irHash };
    const evidence = [
      artifact({ id: 'vitest', runner: 'vitest', engine: 'node', ...measured }),
      artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium', ...measured }),
      artifact({ id: 'pw-chromium', runner: 'playwright', engine: 'chromium', ...measured }),
      artifact({ id: 'pw-firefox', runner: 'playwright', engine: 'firefox', ...measured }),
      artifact({ id: 'pw-webkit', runner: 'playwright', engine: 'webkit', ...measured }),
      artifact({ id: 'lh-mobile', runner: 'lighthouse', engine: 'chromium', metrics: { performance: 0.98 }, ...measured }),
    ];
    // No `previewFaces`: a run where nothing ever served the document.
    const silent = await stage.run({ runId: 'run-no-preview', version, evidence, applier });
    expect(silent.report.parity.matched).toBe(true);
    expect(silent.report.escalations.join(' ')).toMatch(/Fixture Sans 400 normal/);

    // The same bundle, with the faces a preview's document really declared, has
    // nothing open.
    const served = servedFaces(faced);
    const reviewed = await stage.run({ runId: 'run-preview', version, evidence, applier, previewFaces: served });
    expect(reviewed.report.escalations).toEqual([]);
    expect(reviewed.report.parity.matched).toBe(true);

    // A preview whose document named another file for the same face — the face
    // was re-exported after the captain looked at it — is a divergence.
    const moved = await stage.run({ runId: 'run-moved', version, evidence, applier, previewFaces: served.map((face) => ({ ...face, path: 'assets/fonts/fixture-sans-400-normal.000000000000.woff2' })) });
    expect(moved.report.parity.matched).toBe(false);
    expect(moved.report.parity.routes.flatMap((route) => route.differences).join(' ')).toMatch(/A face Fixture Sans 400 normal tem arquivos diferentes/);
  });

  it('keeps missing Codex setup errors actionable in the finalization report', async () => {
    const failures: Array<{ runId: string; expected: RegExp; execute: CodexExecutor }> = [
      {
        runId: 'run-codex-missing',
        expected: /Codex CLI was not found.*codex login/i,
        execute: async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); },
      },
      {
        runId: 'run-codex-auth',
        expected: /Codex CLI is not authenticated.*codex login/i,
        execute: async () => ({ stdout: `${JSON.stringify({ type: 'turn.failed', error: { message: 'Please run codex login.' } })}\n`, stderr: '' }),
      },
    ];
    for (const failure of failures) {
      const runner = new CodexJsonRunner({ execute: failure.execute });
      const { stage, applier, version, evidence } = stageFor([], undefined, new ClaudeReleaseCriticProvider(runner));
      const result = await stage.run({ runId: failure.runId, version, evidence, applier });
      expect(result.report.escalations.join(' ')).toMatch(failure.expected);
    }
  });

  it('refines once, refuses a third attempt at the same finding, and blocks on the evidence veto', async () => {
    const events: string[] = [];
    const { stage, applier, version, evidence } = stageFor([artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium', status: 'failed', metrics: { critical: 2, serious: 1 } })]);
    const result = await stage.run({ runId: 'run-blocked', version, evidence, applier, onEvent: (type) => { events.push(type); } });
    expect(result.cycles).toBe(1);
    expect(result.version.id).not.toBe(version.id);
    expect(result.version.ir.reviewRecord.findings.join(' ')).toMatch(/accessibility:axe-home/);
    expect(result.report.blocked).toBe(true);
    expect(result.report.vetoes.map((veto) => veto.id)).toContain('CRITICAL_AA_REGRESSION');
    expect(result.report.escalations.join(' ')).toMatch(/repetiu em duas rodadas/);
    expect(events).toContain('release.refined');
    expect(events).toContain('release.gate.ready');
  });

  it('never scores a critic on evidence measured against another release', async () => {
    const { stage, applier, version, evidence } = stageFor([
      artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium', status: 'failed', metrics: { critical: 2, serious: 1 }, releaseDigest: 'digest-de-outra-execucao' }),
    ]);
    const result = await stage.run({ runId: 'run-stale', version, evidence, applier });
    expect(result.report.evidence).toEqual([]);
    expect(result.cycles).toBe(0);
    expect(result.critiques.find((critique) => critique.dimension === 'accessibility')).toMatchObject({ rubricScore: 4, verdict: 'pass' });
    expect(result.version.ir.reviewRecord.findings.join(' ')).not.toMatch(/axe-home/);
    expect(result.report.escalations.join(' ')).toMatch(/axe-home.*não conta como cobertura/);
  });

  it('escalates a refiner session that failed instead of losing the whole report', async () => {
    const failing: ReleaseRefinerProvider = { refine: async () => { throw new Error('claude -p saiu com código 1'); } };
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const version = applier.createRoot(createFixtureIR());
    const stage = new FinalizationStage({ modelAlias: 'fake',
      criticProvider: new FakeReleaseCriticProvider(),
      refiner: new PatchRefiner(failing),
      compilerOptions: COMPILER_OPTIONS,
    });
    const evidence = [artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium', status: 'failed', metrics: { critical: 1, serious: 0 } })];
    const result = await stage.run({ runId: 'run-refiner-down', version, evidence, applier });
    expect(result.cycles).toBe(0);
    expect(result.report.vetoes.map((veto) => veto.id)).toContain('CRITICAL_AA_REGRESSION');
    expect(result.report.escalations.join(' ')).toMatch(/patch-refiner falhou.*claude -p saiu com código 1/);
  });

  it('escalates a summarizer session that failed and still reports every veto', async () => {
    const failing: ReleaseSummarizerProvider = { summarize: async () => { throw new Error('a sessão devolveu texto, não JSON'); } };
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const version = applier.createRoot(createFixtureIR());
    const stage = new FinalizationStage({ modelAlias: 'fake',
      criticProvider: new FakeReleaseCriticProvider(),
      refiner: new PatchRefiner(new FakeReleaseRefiner()),
      summarizer: failing,
      compilerOptions: COMPILER_OPTIONS,
    });
    const evidence = [artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium', status: 'failed', metrics: { critical: 1, serious: 0 } })];
    const result = await stage.run({ runId: 'run-summary-down', version, evidence, applier });
    expect(result.report.summary).toBeUndefined();
    expect(result.report.vetoes.map((veto) => veto.id)).toContain('CRITICAL_AA_REGRESSION');
    expect(result.report.escalations.join(' ')).toMatch(/release-summarizer falhou/);
  });

  it('seals a summary its provider did not seal, so no implementation can under-report a veto to the captain', async () => {
    // A third-party `ReleaseSummarizerProvider` that never calls sealSummary and
    // reports a clean release while a veto stands.
    const lying: ReleaseSummarizerProvider = {
      summarize: async () => ({ headline: 'tudo certo, pode publicar', highlights: [], openQuestions: [], vetoCount: 0, gateAuthority: 'none' }),
    };
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const version = applier.createRoot(createFixtureIR());
    const stage = new FinalizationStage({
      modelAlias: 'fake',
      criticProvider: new FakeReleaseCriticProvider(),
      refiner: new PatchRefiner(new FakeReleaseRefiner()),
      summarizer: lying,
      compilerOptions: COMPILER_OPTIONS,
    });
    const evidence = [artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium', status: 'failed', metrics: { critical: 1, serious: 0 } })];
    const result = await stage.run({ runId: 'run-summary-lies', version, evidence, applier });
    expect(result.report.vetoes.map((veto) => veto.id)).toContain('CRITICAL_AA_REGRESSION');
    expect(result.report.summary?.vetoCount).toBe(result.report.vetoes.length);
    expect(result.report.summary?.openQuestions.join(' ')).toMatch(/Regress/);
  });

  it('compares the release against the version the captain approved, not against the refinement it started from', async () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const approved = applier.createRoot(createFixtureIR());
    const refined = createFixtureIR();
    refined.reviewRecord.findings = ['accessibility:axe-home: contraste insuficiente'];
    const current = new Applier(store, new PatchGate()).apply({
      operations: [{ op: 'replace', path: '/reviewRecord/findings', value: refined.reviewRecord.findings }],
      baseVersionId: approved.id, touchedPaths: ['/reviewRecord/findings'], rationale: 'refino anterior', confidence: 1,
      stage: 'finalization', role: 'compiler', idempotencyKey: 'refino-anterior',
    }, { allowedPaths: ['/reviewRecord'], stage: 'finalization', role: 'compiler' }, approved.id);
    const stage = new FinalizationStage({ modelAlias: 'fake',
      criticProvider: new FakeReleaseCriticProvider(),
      refiner: new PatchRefiner(new FakeReleaseRefiner()),
      compilerOptions: COMPILER_OPTIONS,
    });
    const result = await stage.run({ runId: 'run-accumulated', version: current, approved, evidence: [], applier });
    expect(result.report.approvedVersionId).toBe(approved.id);
    expect(result.report.releasedVersionId).toBe(current.id);
    expect(result.report.vetoes.map((veto) => veto.id)).not.toContain('RELEASE_DIVERGES_FROM_APPROVED');
  });

  it('keeps the critics inside the scheduler lane limit', async () => {
    let active = 0;
    let peak = 0;
    const slow = new FakeReleaseCriticProvider();
    const counting = {
      critique: async (task: AgentTask, definition: Parameters<FakeReleaseCriticProvider['critique']>[1]) => {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return slow.critique(task, definition);
      },
    };
    const { stage, applier, version, evidence } = stageFor([], new Scheduler({ maxActiveClaude: 3 }), counting);
    await stage.run({ runId: 'run-lanes', version, evidence, applier });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('the finalization stage model alias', () => {
  it('names the provider that answered on the critic tasks and on the refiner task', async () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const version = applier.createRoot(createFixtureIR());
    const aliases: string[] = [];
    const criticProvider: ReleaseCriticProvider = {
      critique: async (task, definition, signal) => { aliases.push(task.modelAlias); return new FakeReleaseCriticProvider().critique(task, definition, signal); },
    };
    const refiner: ReleaseRefinerProvider = {
      refine: async (task, signal) => { aliases.push(task.modelAlias); return new FakeReleaseRefiner().refine(task, signal); },
    };
    const stage = new FinalizationStage({
      criticProvider,
      refiner: new PatchRefiner(refiner),
      compilerOptions: COMPILER_OPTIONS,
      modelAlias: 'codex-gpt-5.6-sol',
    });
    // A failing artifact is what gives the refiner something to be asked about.
    const evidence = [artifact({ id: 'axe-home', runner: 'axe', engine: 'chromium', status: 'failed', metrics: { critical: 1, serious: 0 } })];
    await stage.run({ runId: 'run-alias', version, evidence, applier });
    expect(aliases.length).toBeGreaterThan(1);
    expect([...new Set(aliases)]).toEqual(['codex-gpt-5.6-sol']);
  });
});

