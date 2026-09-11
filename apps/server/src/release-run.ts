import { join } from 'node:path';
import type { ReleaseGateReport } from '@pwb/domain';
import { appendReleasePublication, loadFontSources, ReleaseVetoError, writeReleaseBundle, type CompiledSite, type FontDecision, type ReleaseManifest } from '@pwb/export';
import type { Applier, VersionRecord } from '@pwb/orchestrator';
import { ClaudeJsonRunner, CodexJsonRunner } from '@pwb/providers';
import {
  ClaudeReleaseCriticProvider, ClaudeReleaseRefiner, ClaudeReleaseSummarizer, DeterministicReleaseSummarizer,
  FakeReleaseCriticProvider, FakeReleaseRefiner, FinalizationStage, PatchRefiner, readEvidence, writeReleaseDocument,
  VETO_CATALOG, type ReleaseCriticProvider, type ReleaseRefinerProvider, type ReleaseSummarizerProvider,
} from '@pwb/stage-finalization';

export interface ReleaseRunOptions {
  releaseRoot: string;
  evidenceDir: string;
  siteUrl?: string;
  siteName?: string;
  modelProvider?: string;
  /** Where the project keeps the faces it may self-host; no manifest means none. */
  fontsDir?: string;
  /**
   * The faces the preview origin served the captain, read when the release is
   * prepared. Gate 3 compares them against the compiled bundle, so a face
   * replaced after the captain looked at it is a divergence and not an
   * identical route. A run with no preview leaves this out.
   */
  previewFaces?: () => FontDecision[] | undefined;
}

/**
 * What Gate 3 needs from the run it is releasing: the version the finalization
 * stage produced, the latest refinement of it, the run's own applier so a
 * refinement becomes a real version, the way to persist that version, and the
 * run's durable log, which is where publishing is recorded.
 */
export interface ReleaseContext {
  approved: VersionRecord;
  current: VersionRecord;
  applier: Applier;
  adopt(version: VersionRecord): Promise<void>;
  record(type: string, payload: Record<string, unknown>): Promise<void>;
  /** Publishing the bundle is what closes the finalization gate; there is no second approval. */
  approveFinalization(approverRole: ReleaseApprover, rationale: string, manifest: ReleaseManifest): Promise<void>;
}

/**
 * Who published. Only the captain may accept an open escalation in writing; a
 * scripted fixture run publishes under its own name and only when the gate left
 * nothing to accept, so no script ever signs for the captain.
 */
export type ReleaseApprover = 'captain' | 'fixture';

/**
 * A release already being prepared in this run. Preparing twice at once would
 * interleave two compilations into one snapshot — and propose the same refiner
 * patch twice — so the second caller is refused the way a taken run id is.
 */
export class ReleasePrepareConflictError extends Error {
  constructor(runId: string) { super(`O release do run ${runId} já está sendo preparado.`); this.name = 'ReleasePrepareConflictError'; }
}

export interface ReleaseSnapshot {
  runId: string;
  digest: string;
  versionId: string;
  refinedFromVersionId: string;
  report: ReleaseGateReport;
  catalog: typeof VETO_CATALOG;
  published?: { directory: string; digest: string };
}

function providers(name: string): { critic: ReleaseCriticProvider; refiner: ReleaseRefinerProvider; summarizer: ReleaseSummarizerProvider } {
  if (name === 'fake') return { critic: new FakeReleaseCriticProvider(), refiner: new FakeReleaseRefiner(), summarizer: new DeterministicReleaseSummarizer() };
  if (name !== 'claude-code' && name !== 'codex') throw new Error(`Unknown model provider ${name}; use fake, claude-code, or codex.`);
  const runner = name === 'codex' ? new CodexJsonRunner() : new ClaudeJsonRunner();
  return { critic: new ClaudeReleaseCriticProvider(runner), refiner: new ClaudeReleaseRefiner(runner), summarizer: new ClaudeReleaseSummarizer(runner) };
}

/**
 * Runs the finalization stage for one run and holds its Gate 3 report.
 *
 * The captain publishes a specific bundle digest. If the report has moved on —
 * because the document changed, or because the refiner produced a new version —
 * publishing is refused, so what reaches disk is always the bundle the captain
 * actually looked at. Every escalation the gate raises has to be accepted in
 * writing before the bundle is written, so a gap is never passed over silently.
 * That acceptance, and the versions the bytes came from, are recorded in the
 * run's log and in the release record beside the bundle — never inside it — so
 * publishing the same bytes again succeeds instead of colliding.
 *
 * This is the only way a release reaches disk: publishing the bundle is what
 * approves the finalization gate, so no second action can write a release with
 * a veto standing or with the gate's open points unaccepted.
 */
export class ReleaseRun {
  private snapshotValue: ReleaseSnapshot | undefined;
  private compiled: CompiledSite | undefined;
  private context: ReleaseContext | undefined;
  private preparing = false;

  constructor(private readonly runId: string, private readonly options: ReleaseRunOptions) {}

  /**
   * Compiles, critiques and evaluates Gate 3, and holds the report.
   *
   * The gate is claimed before the first await, as publishing claims it: two
   * preparations that raced would each run a full stage and then interleave the
   * three assignments this method ends with, so the report could name one
   * execution's digest while the bytes held for publishing came from the other,
   * and both would propose the refiner's patch under the same idempotency key —
   * the loser turning into an escalation the captain never caused.
   */
  async prepare(context: ReleaseContext, signal?: AbortSignal): Promise<ReleaseSnapshot> {
    if (this.preparing) throw new ReleasePrepareConflictError(this.runId);
    this.preparing = true;
    try { return await this.prepareClaimed(context, signal); }
    finally { this.preparing = false; }
  }

  private async prepareClaimed(context: ReleaseContext, signal?: AbortSignal): Promise<ReleaseSnapshot> {
    const chosen = providers(this.options.modelProvider ?? 'fake');
    const fonts = await loadFontSources(this.options.fontsDir);
    const stage = new FinalizationStage({
      criticProvider: chosen.critic,
      refiner: new PatchRefiner(chosen.refiner),
      summarizer: chosen.summarizer,
      compilerOptions: { siteUrl: this.options.siteUrl ?? 'https://site.invalid', siteName: this.options.siteName ?? 'pro-website-builder', ...(fonts.length > 0 ? { fonts } : {}) },
    });
    // The evidence runners compile the document the gate compiles, so they can
    // stamp their artifacts with the release they actually measured.
    await writeReleaseDocument(this.options.evidenceDir, context.current.ir);
    const evidence = await readEvidence(this.options.evidenceDir);
    const previewFaces = this.options.previewFaces?.();
    const result = await stage.run({
      runId: this.runId,
      version: context.current,
      approved: context.approved,
      evidence,
      ...(previewFaces ? { previewFaces } : {}),
      applier: context.applier,
      onEvent: (type, payload) => context.record(type, payload),
      ...(signal ? { signal } : {}),
    });
    if (result.version.id !== context.current.id) await context.adopt(result.version);
    this.context = context;
    this.compiled = result.compiled;
    this.snapshotValue = {
      runId: this.runId,
      digest: result.compiled.digest,
      versionId: result.version.id,
      refinedFromVersionId: context.approved.id,
      report: result.report,
      catalog: VETO_CATALOG,
    };
    return this.snapshotValue;
  }

  snapshot(): ReleaseSnapshot | undefined { return this.snapshotValue ? structuredClone(this.snapshotValue) : undefined; }

  /** Only the exact bundle the report describes, and only on terms the publisher may sign. */
  async publish(approverRole: string, digest: string, rationale?: string): Promise<ReleaseManifest> {
    if (approverRole !== 'captain' && approverRole !== 'fixture') throw new Error('Só o capitão aprova o gate de release.');
    const current = this.snapshotValue;
    if (!current || !this.compiled || !this.context) throw new Error('O release ainda não foi preparado nesta execução.');
    if (digest !== current.digest) throw new Error(`O capitão aprovou o bundle ${digest}, e o release atual é ${current.digest}.`);
    if (current.report.blocked) throw new ReleaseVetoError(current.report.vetoes);
    const escalations = current.report.escalations;
    const reason = rationale?.trim() ?? '';
    if (escalations.length > 0 && approverRole !== 'captain') {
      throw new Error(`O release tem ${escalations.length} ponto(s) em aberto que só o capitão pode aceitar por escrito: ${escalations.join(' ')}`);
    }
    if (escalations.length > 0 && reason === '') {
      throw new Error(`O release tem ${escalations.length} ponto(s) em aberto que o capitão precisa aceitar por escrito: ${escalations.join(' ')}`);
    }
    const manifest = await writeReleaseBundle(this.compiled, this.options.releaseRoot);
    await appendReleasePublication(this.options.releaseRoot, {
      digest: manifest.digest,
      approvedVersionId: current.report.approvedVersionId,
      releasedVersionId: current.versionId,
      irHash: current.report.irHash,
      approverRole,
      rationale: reason,
      acceptedEscalations: escalations,
    });
    await this.context.record('release.published', { digest: manifest.digest, versionId: current.versionId, approverRole, rationale: reason, escalations });
    await this.context.approveFinalization(approverRole, reason, manifest);
    this.snapshotValue = { ...current, published: { directory: join(this.options.releaseRoot, manifest.digest), digest: manifest.digest } };
    return manifest;
  }
}
