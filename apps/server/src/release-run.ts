import type { DesignIR, ReleaseGateReport } from '@pwb/domain';
import { ReleaseVetoError, writeReleaseBundle, type CompiledSite, type ReleaseManifest } from '@pwb/export';
import { Applier, PatchGate, VersionStore } from '@pwb/orchestrator';
import { ClaudeJsonRunner } from '@pwb/providers';
import {
  ClaudeReleaseCriticProvider, ClaudeReleaseRefiner, ClaudeReleaseSummarizer, DeterministicReleaseSummarizer,
  FakeReleaseCriticProvider, FakeReleaseRefiner, FinalizationStage, PatchRefiner, readEvidence,
  VETO_CATALOG, type ReleaseCriticProvider, type ReleaseRefinerProvider, type ReleaseSummarizerProvider,
} from '@pwb/stage-finalization';

export interface ReleaseRunOptions {
  releaseRoot: string;
  evidenceDir: string;
  siteUrl: string;
  siteName: string;
  modelProvider?: string;
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
  if (name !== 'claude-code') throw new Error(`Unknown model provider ${name}; use fake or claude-code.`);
  const runner = new ClaudeJsonRunner();
  return { critic: new ClaudeReleaseCriticProvider(runner), refiner: new ClaudeReleaseRefiner(runner), summarizer: new ClaudeReleaseSummarizer(runner) };
}

/**
 * Runs the finalization stage for one run and holds its Gate 3 report.
 *
 * The captain publishes a specific bundle digest. If the report has moved on —
 * because the document changed, or because the refiner produced a new version —
 * publishing is refused, so what reaches disk is always the bundle the captain
 * actually looked at.
 */
export class ReleaseRun {
  private snapshotValue: ReleaseSnapshot | undefined;
  private compiled: CompiledSite | undefined;

  constructor(private readonly runId: string, private readonly options: ReleaseRunOptions) {}

  async prepare(ir: DesignIR, approvedVersionId: string, signal?: AbortSignal): Promise<ReleaseSnapshot> {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const approved = applier.createRoot({ ...ir, meta: { ...ir.meta, versionId: approvedVersionId } });
    const chosen = providers(this.options.modelProvider ?? 'fake');
    const stage = new FinalizationStage({
      criticProvider: chosen.critic,
      refiner: new PatchRefiner(chosen.refiner),
      summarizer: chosen.summarizer,
      compilerOptions: { siteUrl: this.options.siteUrl, siteName: this.options.siteName },
    });
    const evidence = await readEvidence(this.options.evidenceDir);
    const result = await stage.run({ runId: this.runId, version: approved, evidence, applier, ...(signal ? { signal } : {}) });
    this.compiled = result.compiled;
    this.snapshotValue = {
      runId: this.runId,
      digest: result.compiled.digest,
      versionId: result.version.id,
      refinedFromVersionId: approved.id,
      report: result.report,
      catalog: VETO_CATALOG,
    };
    return this.snapshotValue;
  }

  snapshot(): ReleaseSnapshot | undefined { return this.snapshotValue ? structuredClone(this.snapshotValue) : undefined; }

  /** Only the captain publishes, and only the exact bundle the report describes. */
  async publish(approverRole: string, digest: string): Promise<ReleaseManifest> {
    if (approverRole !== 'captain') throw new Error('Só o capitão aprova o gate de release.');
    const current = this.snapshotValue;
    if (!current || !this.compiled) throw new Error('O release ainda não foi preparado nesta execução.');
    if (digest !== current.digest) throw new Error(`O capitão aprovou o bundle ${digest}, e o release atual é ${current.digest}.`);
    if (current.report.blocked) throw new ReleaseVetoError(current.report.vetoes);
    const manifest = await writeReleaseBundle(this.compiled, this.options.releaseRoot, { approvedVersionId: current.versionId });
    this.snapshotValue = { ...current, published: { directory: manifest.directory, digest: manifest.digest } };
    return manifest;
  }
}
