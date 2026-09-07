import { hashJson, stageRoles, type AgentTask, type DesignIR, type EvidenceArtifact, type ReleaseCritique, type ReleaseFinding, type ReleaseGateReport, type ReleaseSummary } from '@pwb/domain';
import { compileRelease, type CompiledSite, type ReleaseCompilerOptions } from '@pwb/export';
import type { Applier, VersionRecord } from '@pwb/orchestrator';
import { Scheduler } from '@pwb/orchestrator';
import { renderDesign } from '@pwb/renderer';
import { criticTasks, type CriticTaskContext } from './critics.js';
import type { ReleaseCriticProvider } from './critic-provider.js';
import { partitionEvidence } from './evidence.js';
import { evaluateReleaseGate } from './gate.js';
import { checkPreviewReleaseParity } from './parity.js';
import { PatchRefiner } from './refiner.js';
import { DeterministicReleaseSummarizer, type ReleaseSummarizerProvider } from './summarizer.js';

export interface FinalizationStageOptions {
  criticProvider: ReleaseCriticProvider;
  refiner: PatchRefiner;
  summarizer?: ReleaseSummarizerProvider;
  scheduler?: Scheduler;
  compilerOptions: Omit<ReleaseCompilerOptions, 'fonts'> & Pick<ReleaseCompilerOptions, 'fonts'>;
  promptVersion?: string;
  modelAlias?: string;
}

export interface FinalizationStageInput {
  runId: string;
  /** The document to compile: the approved one, or the last refinement of it. */
  version: VersionRecord;
  /**
   * The version the captain approved coming into the stage. It differs from
   * `version` once a previous Gate 3 run refined the document, and it is what
   * the divergence veto compares the release against.
   */
  approved?: VersionRecord;
  evidence: EvidenceArtifact[];
  applier: Applier;
  signal?: AbortSignal;
  onEvent?: (type: string, payload: Record<string, unknown>) => void | Promise<void>;
}

export interface FinalizationStageResult {
  version: VersionRecord;
  compiled: CompiledSite;
  critiques: ReleaseCritique[];
  report: ReleaseGateReport;
  cycles: number;
}

/**
 * The refiner writes the review record and nothing else: the bytes the release
 * publishes have to be the bytes the captain approved, so a refinement that
 * changed a rendered file could never be published anyway.
 */
const REFINER_PATHS: string[] = ['/reviewRecord'];

/**
 * Whether two versions say the same thing.
 *
 * A version's id is derived from a document that still names its parent, so
 * re-applying a patch that changes nothing still mints a new id. Comparing the
 * documents with that name removed is what tells a real refinement from a
 * rewrite of what the review record already said.
 */
function sameDocument(a: DesignIR, b: DesignIR): boolean {
  const withoutId = (ir: DesignIR): unknown => ({ ...ir, meta: { ...ir.meta, versionId: '' } });
  return hashJson(withoutId(a)) === hashJson(withoutId(b));
}

/**
 * The finalization stage: compile, fan out five read-only critics, run the
 * deterministic checks, refine at most twice, and stop at the captain's gate.
 *
 * Parallelism here is by contract, never by concurrent writes. The five critics
 * run against an immutable slice of one compiled bundle; the refiner is serial
 * and is the only participant that produces a patch; only the Applier writes a
 * version; and the gate report is recomputed from the artifacts each time.
 */
export class FinalizationStage {
  private readonly scheduler: Scheduler;
  private readonly summarizer: ReleaseSummarizerProvider;

  constructor(private readonly options: FinalizationStageOptions) {
    this.scheduler = options.scheduler ?? new Scheduler();
    this.summarizer = options.summarizer ?? new DeterministicReleaseSummarizer();
  }

  async run(input: FinalizationStageInput): Promise<FinalizationStageResult> {
    const emit = async (type: string, payload: Record<string, unknown>): Promise<void> => { await input.onEvent?.(type, payload); };
    let version = input.version;
    let compiled = this.compile(version.ir);
    // What the captain approved coming into this stage, kept so the gate can see
    // whether refinement changed the release rather than only the review record.
    const approvedVersion = input.approved ?? input.version;
    const approvedCompile = approvedVersion.id === version.id ? compiled : this.compile(approvedVersion.ir);
    const approved = { versionId: approvedVersion.id, irHash: approvedCompile.irHash, renderedFiles: approvedCompile.files.map((file) => [file.path, file.hash] as [string, string]) };
    let critiques = await this.critique(input, version, compiled);
    const escalations: string[] = [];
    let previousFindingIds: string[] = [];
    let cycles = 0;

    for (;;) {
      const findings = critiques.flatMap((critique) => critique.findings);
      const decision = this.options.refiner.decide(cycles, findings, previousFindingIds);
      if (decision.action === 'stop') { escalations.push(...decision.escalations); await emit('release.refinement.stopped', { reason: decision.reason, cycles }); break; }
      previousFindingIds = decision.findingIds;
      const task = this.refinerTask(input.runId, version, compiled, findings, cycles + 1);
      // A model session that fails takes its own cycle down, never the report:
      // the vetoes and the evidence already computed are what the captain needs
      // most when the refiner cannot answer.
      let next: VersionRecord;
      try {
        const patch = await this.options.refiner.propose(task, findings.filter((finding) => finding.severity === 'error'), input.signal);
        if (!patch) { escalations.push('O patch-refiner não produziu proposta; os achados abertos sobem para o capitão.'); await emit('release.refinement.stopped', { reason: 'no-proposal', cycles }); break; }
        // Applying a patch spends its idempotency key against the base version,
        // so a rewrite of what the review record already says is recognised
        // before it is applied rather than minted and discarded.
        if (sameDocument(input.applier.dryRun(patch, task, version.id).next, version.ir)) {
          escalations.push('O patch-refiner reescreveu o que o registro de revisão já dizia; os achados abertos sobem para o capitão.');
          await emit('release.refinement.stopped', { reason: 'no-change', cycles });
          break;
        }
        next = input.applier.apply(patch, task, version.id);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        const reason = error instanceof Error ? error.message : 'O patch-refiner falhou sem mensagem.';
        escalations.push(`O patch-refiner falhou no ciclo ${cycles + 1} e os achados seguem abertos: ${reason}`);
        await emit('release.refinement.stopped', { reason: 'refiner-failed', cycles, detail: reason });
        break;
      }
      version = next;
      cycles += 1;
      await emit('release.refined', { cycle: cycles, versionId: version.id, findings: previousFindingIds });
      compiled = this.compile(version.ir);
      critiques = await this.critique(input, version, compiled);
    }

    const parity = checkPreviewReleaseParity(renderDesign(version.ir), compiled, new Map(version.ir.pages.routes.map((page) => [page.route, page.id])));
    const draft = evaluateReleaseGate({
      compiled,
      evidence: input.evidence,
      critiques,
      parity,
      approved,
      releasedVersionId: version.id,
      refinementCycles: cycles,
      escalations,
    });
    // The summarizer has no gate authority, so its failure cannot cost the
    // captain the report either: it escalates and the report goes out unsummarized.
    let summary: ReleaseSummary | undefined;
    try {
      summary = await this.summarizer.summarize({ bundleDigest: compiled.digest, vetoes: draft.vetoes, critiques, escalations: draft.escalations }, input.signal);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : 'O release-summarizer falhou sem mensagem.';
      escalations.push(`O release-summarizer falhou e o release segue sem resumo: ${reason}`);
      await emit('release.summary.failed', { reason });
    }
    // The report is rebuilt with the summary attached, never adjusted by it.
    const report = evaluateReleaseGate({
      compiled,
      evidence: input.evidence,
      critiques,
      parity,
      approved,
      releasedVersionId: version.id,
      refinementCycles: cycles,
      escalations,
      ...(summary ? { summary } : {}),
    });
    await emit('release.gate.ready', { blocked: report.blocked, vetoes: report.vetoes.length, digest: report.bundleDigest });
    return { version, compiled, critiques, report, cycles };
  }

  compile(ir: DesignIR): CompiledSite {
    return compileRelease(renderDesign(ir), ir, this.options.compilerOptions);
  }

  private async critique(input: FinalizationStageInput, version: VersionRecord, compiled: CompiledSite): Promise<ReleaseCritique[]> {
    const context: CriticTaskContext = {
      runId: input.runId,
      baseVersionId: version.id,
      ir: version.ir,
      compiled,
      evidence: partitionEvidence(input.evidence, { digest: compiled.digest, irHash: compiled.irHash }).credited,
      attempt: 1,
      promptVersion: this.options.promptVersion ?? 'phase3-v1',
      modelAlias: this.options.modelAlias ?? 'claude-local',
    };
    const built = criticTasks(context);
    const byId = new Map(built.map((entry) => [entry.task.id, entry.definition]));
    const result = await this.scheduler.run(
      built.map((entry) => entry.task),
      async (task, signal) => this.options.criticProvider.critique(task, byId.get(task.id)!, signal),
      { ...(input.signal ? { signal: input.signal } : {}) },
    );
    for (const entry of result.results) {
      if (entry.state === 'succeeded') continue;
      await input.onEvent?.('release.critic.failed', { taskId: entry.task.id, state: entry.state, reason: entry.error instanceof Error ? entry.error.message : 'O crítico não entregou parecer.' });
    }
    return result.results
      .flatMap((entry) => (entry.state === 'succeeded' && entry.value ? [entry.value] : []))
      .sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0));
  }

  private refinerTask(runId: string, version: VersionRecord, compiled: CompiledSite, findings: ReleaseFinding[], attempt: number): AgentTask {
    const documentSlice: Record<string, unknown> = {
      '/identity': version.ir.identity,
      '/reviewRecord': version.ir.reviewRecord,
      '/release': { digest: compiled.digest, routes: compiled.routes, vetoes: compiled.vetoes },
      '/findings': findings,
    };
    return {
      id: `release-patch-refiner#${runId}`,
      attempt,
      stage: 'finalization',
      role: stageRoles.finalization,
      state: 'queued',
      lane: 'claude',
      baseVersionId: version.id,
      inputDigest: hashJson({ runId, attempt, findings: findings.map((finding) => finding.id).sort() }),
      promptVersion: this.options.promptVersion ?? 'phase3-v1',
      modelAlias: this.options.modelAlias ?? 'claude-local',
      deadlineMs: 8 * 60_000,
      allowedPaths: REFINER_PATHS,
      brief: 'Resolva os achados de release com o menor patch possível, sem reescrever o site.',
      documentSlice,
    };
  }
}
