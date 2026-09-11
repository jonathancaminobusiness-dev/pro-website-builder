import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReleaseGateReport } from '@pwb/domain';
import { appendReleasePublication, loadFontSources, ReleaseVetoError, writeReleaseBundle, type CompiledSite, type ReleaseManifest, type ReleasePublication, type ServedFace } from '@pwb/export';
import type { Applier, VersionRecord } from '@pwb/orchestrator';
import { ClaudeJsonRunner, CodexJsonRunner } from '@pwb/providers';
import { modelAlias, modelProviderName, type ModelProviderName } from './provider.js';
import { siteFromEnvironment } from './site-environment.js';
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
  modelProvider?: ModelProviderName;
  /** Where the project keeps the faces it may self-host; no manifest means none. */
  fontsDir?: string;
  /**
   * The faces the preview origin served, asked for the very version Gate 3 is
   * about to compile so a script can serve that document before answering.
   * Gate 3 compares them against the compiled bundle, so a face replaced after
   * the captain looked at it is a divergence and not an identical route. A run
   * with no preview leaves this out.
   */
  previewFaces?: (version: VersionRecord) => Promise<ServedFace[] | undefined> | ServedFace[] | undefined;
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

/**
 * A publish the release itself refuses: the bundle the captain approved is not
 * the one this run now holds, a veto still stands, an open point was never
 * accepted in writing, or nothing was prepared at all.
 *
 * None of these is a server failure — the state moved, or never allowed the
 * publish — so the API answers them the way it already answers a blocked
 * prepare, and the Studio can tell "the release changed" from "the server
 * broke" instead of reading 500 for both.
 */
export class ReleasePublishRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'ReleasePublishRefusedError'; }
}

export interface ReleaseSnapshot {
  runId: string;
  digest: string;
  versionId: string;
  refinedFromVersionId: string;
  report: ReleaseGateReport;
  catalog: typeof VETO_CATALOG;
  /**
   * The bundle this run published. `recordPending` says the bytes and the
   * acceptance are both durable but the publication record beside them is not
   * yet written, so the release is published and its provenance is owed.
   */
  published?: { directory: string; digest: string; recordPending?: true };
}

function providers(name: ModelProviderName): { critic: ReleaseCriticProvider; refiner: ReleaseRefinerProvider; summarizer: ReleaseSummarizerProvider } {
  if (name === 'fake') return { critic: new FakeReleaseCriticProvider(), refiner: new FakeReleaseRefiner(), summarizer: new DeterministicReleaseSummarizer() };
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
  private pendingPublication: { entry: ReleasePublication; directory: string; versionId: string; escalations: string[] } | undefined;

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
    const name = modelProviderName(this.options.modelProvider);
    const chosen = providers(name);
    const site = siteFromEnvironment();
    const fonts = await loadFontSources(this.options.fontsDir);
    const stage = new FinalizationStage({
      criticProvider: chosen.critic,
      refiner: new PatchRefiner(chosen.refiner),
      summarizer: chosen.summarizer,
      // The critics and the refiner record the provider that actually answered;
      // `idempotencyKey` hashes the alias, so it may not name Claude under Codex.
      modelAlias: modelAlias(name),
      compilerOptions: { siteUrl: this.options.siteUrl ?? site.siteUrl, siteName: this.options.siteName ?? site.siteName, ...(fonts.length > 0 ? { fonts } : {}) },
    });
    // The evidence runners compile the document the gate compiles, so they can
    // stamp their artifacts with the release they actually measured.
    await writeReleaseDocument(this.options.evidenceDir, context.current.ir);
    const evidence = await readEvidence(this.options.evidenceDir);
    const previewFaces = await this.options.previewFaces?.(context.current);
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
    if (!current || !this.compiled || !this.context) throw new ReleasePublishRefusedError('O release ainda não foi preparado nesta execução.');
    if (digest !== current.digest) throw new ReleasePublishRefusedError(`O capitão aprovou o bundle ${digest}, e o release atual é ${current.digest}.`);
    if (current.report.blocked) throw new ReleaseVetoError(current.report.vetoes);
    const escalations = current.report.escalations;
    const reason = rationale?.trim() ?? '';
    if (escalations.length > 0 && approverRole !== 'captain') {
      throw new ReleasePublishRefusedError(`O release tem ${escalations.length} ponto(s) em aberto que só o capitão pode aceitar por escrito: ${escalations.join(' ')}`);
    }
    if (escalations.length > 0 && reason === '') {
      throw new ReleasePublishRefusedError(`O release tem ${escalations.length} ponto(s) em aberto que o capitão precisa aceitar por escrito: ${escalations.join(' ')}`);
    }
    // A bundle on disk is a published release, so it never outlives the
    // acceptance of it: the bytes are written first and the gate is approved in
    // one commit, and a publish that dies before that commit takes its bytes
    // with it rather than leaving them behind with the run still needing
    // review. A bundle that was already there — the same bytes published before
    // — is never touched: its own record is what stands for it.
    const directory = join(this.options.releaseRoot, current.digest);
    const preexisting = await stat(directory).then(() => true, () => false);
    const manifest = await writeReleaseBundle(this.compiled, this.options.releaseRoot);
    try {
      await this.context.approveFinalization(approverRole, reason, manifest);
    } catch (error) {
      if (!preexisting) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    // Past the commit the release is published, so nothing is removed again.
    // The record of who accepted it is written last and is owed until it lands:
    // publishing this digest again writes it, and appending it twice is not a
    // second publication.
    this.pendingPublication = {
      directory,
      versionId: current.versionId,
      escalations,
      entry: {
        digest: manifest.digest,
        approvedVersionId: current.report.approvedVersionId,
        releasedVersionId: current.versionId,
        irHash: current.report.irHash,
        approverRole,
        rationale: reason,
        acceptedEscalations: escalations,
      },
    };
    this.snapshotValue = { ...current, published: { directory, digest: manifest.digest, recordPending: true } };
    await this.recordPublication();
    return manifest;
  }

  /** Writes the publication record a published bundle is still owed, if any. */
  async recordPublication(): Promise<void> {
    const pending = this.pendingPublication;
    if (!pending || !this.context || !this.snapshotValue) return;
    await appendReleasePublication(this.options.releaseRoot, pending.entry);
    await this.context.record('release.published', { digest: pending.entry.digest, versionId: pending.versionId, approverRole: pending.entry.approverRole, rationale: pending.entry.rationale, escalations: pending.escalations });
    this.pendingPublication = undefined;
    this.snapshotValue = { ...this.snapshotValue, published: { directory: pending.directory, digest: pending.entry.digest } };
  }
}
