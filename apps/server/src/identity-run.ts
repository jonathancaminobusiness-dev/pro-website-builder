import { randomUUID } from 'node:crypto';
import { createFixtureIR, flattenTokens, type Approval, type TokenValue } from '@pwb/domain';
import { lintDesign } from '@pwb/linter';
import { Applier, PatchGate, Scheduler, VersionStore, type VersionRecord } from '@pwb/orchestrator';
import { HiggsfieldMcpProvider, type ModelProvider, type RasterProvider } from '@pwb/providers';
import { renderDesign, type RenderedDocument } from '@pwb/renderer';
import { approvalOf, identityHash, IdentityStage, pruneRenderCache, StageError, type IdentityAsset, type IdentityCandidate, type IdentityGateState, type IdentityHandoff, type IdentityStageResult } from '@pwb/stage-identity';
import type { ProjectRepository } from './db/repository.js';

const duplicateCodes = new Set(['SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE']);
async function ignoringDuplicate(write: Promise<void>): Promise<void> {
  try { await write; } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (!duplicateCodes.has(code)) throw error;
  }
}

export const IDENTITY_BRIEFING = 'Uma oficina de produto autoral precisa explicar seu processo sem parecer agência. A promessa é clareza com personalidade e a prova é o registro de cada decisão. Exclusão declarada: nada que pareça um SaaS genérico de template.';

export type IdentityRunStatus = 'queued' | 'running' | 'needs_review' | 'approved' | 'cancelled' | 'reopened' | 'interrupted' | 'failed';

/**
 * The one row a restarted server rebuilds a run from. Versions, approvals and
 * events are already persisted by the rest of the product; what the stage
 * measured once and cannot measure again — the brief, the candidates, the
 * critiques and the generated assets — is written here after every step that
 * changes it, so an open Gate 1 outlives the process that opened it.
 */
const CHECKPOINT_EVENT = 'identity.run.checkpoint';
interface IdentityCheckpoint { currentVersionId?: string; assets?: IdentityAsset[]; result: IdentityStageResult }

const INTERRUPTED = 'The server restarted while the identity stage was running, so that fan-out was lost. Start the stage again.';

/** What the Gate 1 screen reads: three directions side by side, with everything the captain needs to decide. */
export interface IdentityDirectionView {
  directionId: string;
  label: string;
  versionId: string;
  parentVersionId: string;
  identityHash: string;
  thesis: string;
  tension: string;
  rationale: string;
  exclusions: string[];
  forbiddenDefaults: { fonts: string[]; palettes: string[]; motifs: string[] };
  axes: Array<{ axis: string; key: string; descriptor: string }>;
  swatches: Array<{ path: string; value: string }>;
  decisions: Array<{ choice: string; axis?: string; evidenceIds: string[]; rationale?: string }>;
  lintErrors: Array<{ id: string; path: string; message: string }>;
  blocking: Array<{ id: string; observation: string; why: string }>;
  scores: Array<{ criticId: string; dimension: string; score: number }>;
  rubricGaps: Array<{ dimension: string; score: number; evidence: string }>;
  /** Rubrics no critic scored for this direction, and the failing DIV-030 pairs it is part of. */
  unscoredDimensions: string[];
  blockedPairs: string[];
  abstained: boolean;
  refinedFromVersionId?: string;
  imagePlans: Array<{ id: string; role: string; axis: string; alt: string; licenceExpectation: string }>;
  imageryViolations: string[];
}

export interface IdentityRunSnapshot {
  runId: string;
  projectId: string;
  status: IdentityRunStatus;
  baseVersionId: string;
  briefing: string;
  brief?: IdentityStageResult['brief'];
  directions: IdentityDirectionView[];
  divergence?: { passed: boolean; blockedPairs: string[]; pairs: Array<{ a: string; b: string; distinctAxes: string[]; hueOnlyColor: boolean }> };
  critiques: IdentityStageResult['critiques'];
  /** What the critics said about the fan-out as a whole; it belongs to the gate, not to a card. */
  setCritique: IdentityStageResult['setCritique'];
  failures: Array<{ taskId: string; reason: string }>;
  gate: IdentityGateState;
  approvals: Approval[];
  assets: IdentityAsset[];
  previewVersionId?: string;
  /** What the prototype stage plans against once Gate 1 closes. */
  handoff?: IdentityHandoff;
  error?: string;
}

/**
 * Drives the identity stage for one run and persists what the rest of the
 * product already knows how to store: versions, patches, approvals and events.
 * Model work starts only inside `start`, which the API reaches only from an
 * explicit captain action.
 */
export class IdentityRun {
  private readonly store = new VersionStore();
  private readonly stage: IdentityStage;
  private readonly approvals: Approval[] = [];
  private readonly rendered = new Map<string, RenderedDocument>();
  private root!: VersionRecord;
  private result: IdentityStageResult | undefined;
  private status: IdentityRunStatus = 'queued';
  private assets: IdentityAsset[] = [];
  private failure: string | undefined;
  private started = false;
  private inFlight: Promise<void> | undefined;
  private settling: Promise<void> | undefined;
  private abort: AbortController | undefined;

  constructor(private readonly options: { runId: string; repository: ProjectRepository; provider: ModelProvider; raster?: RasterProvider; scheduler?: Scheduler; briefing?: string; renderCacheDir?: string }) {
    const ir = createFixtureIR();
    this.root = new Applier(this.store, new PatchGate()).createRoot(ir);
    this.rendered.set(this.root.id, renderDesign(this.root.ir));
    this.stage = new IdentityStage({
      runId: options.runId,
      baseVersionId: this.root.id,
      briefing: options.briefing ?? IDENTITY_BRIEFING,
      provider: options.provider,
      store: this.store,
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      raster: options.raster ?? new HiggsfieldMcpProvider({ configured: false }),
      onEvent: (type, payload) => ignoringDuplicate(this.options.repository.appendEvent({ id: randomUUID(), runId: this.options.runId, type, payload })),
    });
  }

  async initialize(): Promise<void> {
    await ignoringDuplicate(this.options.repository.createProject({ id: this.projectId, name: 'Identity stage project' }));
    await ignoringDuplicate(this.options.repository.createRun({ id: this.options.runId, projectId: this.projectId }));
    await ignoringDuplicate(this.options.repository.saveVersion({ id: this.root.id, projectId: this.projectId, hash: this.root.hash, ir: this.root.ir }));
  }

  /**
   * Rebuilds a persisted run so a restarted server can serve, decide and change
   * an identity it already paid for. A run whose stage was still in flight when
   * the process ended has no checkpoint, so it comes back as `interrupted` and
   * the captain can start it again rather than reading a bare 404.
   */
  async restore(): Promise<boolean> {
    const run = await this.options.repository.getRun(this.options.runId);
    if (!run) return false;
    for (const version of await this.options.repository.listVersions(run.projectId)) {
      if (this.store.get(version.id)) continue;
      this.store.save({ id: version.id, ...(version.parentId ? { parentId: version.parentId } : {}), hash: version.hash, ir: version.ir });
    }
    this.approvals.push(...await this.options.repository.listApprovals(this.options.runId));
    const events = await this.options.repository.listEvents(this.options.runId);
    const checkpoint = events.filter((event) => event.type === CHECKPOINT_EVENT).at(-1);
    if (!checkpoint) {
      const failed = events.filter((event) => event.type === 'identity.stage.failed').at(-1);
      if (failed) this.failure = typeof failed.payload.reason === 'string' ? failed.payload.reason : 'The identity stage failed.';
      else if (events.some((event) => event.type === 'identity.stage.started')) this.failure = INTERRUPTED;
      this.status = failed ? 'failed' : this.failure ? 'interrupted' : 'queued';
      return true;
    }
    const state = checkpoint.payload as unknown as IdentityCheckpoint;
    this.stage.restore({ result: state.result, ...(state.currentVersionId ? { currentVersionId: state.currentVersionId } : {}), assets: state.assets ?? [] });
    this.result = this.stage.snapshot();
    // The stage settles what the ended process left in flight, so the snapshot
    // reads what became of every image rather than one that never finishes.
    this.assets = this.stage.approvedImagery;
    // The label is derived from the gate, exactly as it is on the live path.
    const gate = this.result.gate;
    this.status = gate.state === 'closed' ? 'approved' : gate.state === 'reopened' ? 'reopened' : 'needs_review';
    this.started = true;
    for (const candidate of this.result.candidates) this.render(candidate.versionId);
    this.render(this.stage.approvedVersionId);
    return true;
  }

  private render(versionId: string | undefined): void {
    const version = versionId ? this.store.get(versionId) : undefined;
    if (version) this.rendered.set(version.id, renderDesign(version.ir));
  }

  private async checkpoint(): Promise<void> {
    if (!this.result) return;
    const payload: IdentityCheckpoint = {
      ...(this.stage.approvedVersionId ? { currentVersionId: this.stage.approvedVersionId } : {}),
      assets: this.assets,
      result: this.result,
    };
    await ignoringDuplicate(this.options.repository.appendEvent({ id: randomUUID(), runId: this.options.runId, type: CHECKPOINT_EVENT, payload: payload as unknown as Record<string, unknown> }));
  }

  /** The one entry point that spends model turns. Nothing else in this class starts a worker. */
  async start(): Promise<IdentityRunSnapshot> {
    if (this.status === 'cancelled') throw new StageError('This run was cancelled; create another one to run the identity stage.');
    if (this.started) { await this.inFlight; return this.snapshot(); }
    this.started = true;
    this.status = 'running';
    this.abort = new AbortController();
    this.failure = undefined;
    this.inFlight = this.stage.run(this.abort.signal).then(async (result) => {
      this.result = result;
      await this.persistCandidates(result);
      this.status = 'needs_review';
      await this.checkpoint();
    }).catch(async (error: unknown) => {
      this.failure = error instanceof Error ? error.message : 'The identity stage failed.';
      this.status = 'failed';
      await ignoringDuplicate(this.options.repository.appendEvent({ id: randomUUID(), runId: this.options.runId, type: 'identity.stage.failed', payload: { reason: this.failure } }));
    });
    await this.inFlight;
    return this.snapshot();
  }

  async cancel(): Promise<IdentityRunSnapshot> {
    this.abort?.abort();
    await this.inFlight;
    // Imagery outlives the approve call, so cancelling the run has to reach it
    // too; what it did not finish stays recorded as a failed asset.
    await this.stage.cancelImagery();
    await this.settling;
    // Stopping the work that followed a decision does not undo the decision:
    // only a run the captain never got to decide becomes a cancelled one, and
    // a run that survives its cancel gets a fresh scope for what comes next.
    if (this.stage.gateState().state !== 'open') { this.abort = new AbortController(); return this.snapshot(); }
    this.status = 'cancelled';
    this.failure = undefined;
    await ignoringDuplicate(this.options.repository.appendEvent({ id: randomUUID(), runId: this.options.runId, type: 'identity.run.cancelled', payload: { runId: this.options.runId } }));
    return this.snapshot();
  }

  async approve(input: { directionId: string; approverRole: string; rationale: string; overrideRationale?: string }): Promise<IdentityRunSnapshot> {
    if (this.status === 'cancelled') throw new StageError('This run was cancelled; Gate 1 cannot be decided on it.');
    const approval = await this.stage.approve({ ...input, ...(this.abort ? { signal: this.abort.signal } : {}) });
    const record: Approval = approvalOf(approval.record, this.approvals.length);
    await ignoringDuplicate(this.options.repository.createApproval({ ...record, runId: this.options.runId, projectId: this.projectId }));
    this.approvals.push(record);
    this.assets = approval.assets;
    const withAssets = this.store.get(approval.versionId);
    if (withAssets) {
      await ignoringDuplicate(this.options.repository.saveVersion({ id: withAssets.id, projectId: this.projectId, ...(withAssets.parentId ? { parentId: withAssets.parentId } : {}), hash: withAssets.hash, ir: withAssets.ir }));
      this.rendered.set(withAssets.id, renderDesign(withAssets.ir));
    }
    this.status = 'approved';
    this.result = this.stage.snapshot();
    await this.checkpoint();
    // The gate is decided; the images are still being shot on the raster lane.
    // The snapshot carries them as `generating` and is written again when they
    // settle, so a restart reads what the lane actually produced.
    this.settling = this.settleImagery();
    return this.snapshot();
  }

  private async settleImagery(): Promise<void> {
    try {
      await this.stage.imagerySettled();
      this.assets = this.stage.approvedImagery;
      this.result = this.stage.snapshot();
      await this.checkpoint();
    } catch (error) {
      this.failure = error instanceof Error ? error.message : 'The imagery for the approved direction did not settle.';
    }
  }

  async reject(input: { directionId: string; approverRole: string; rationale: string }): Promise<IdentityRunSnapshot> {
    if (input.approverRole !== 'captain') throw new StageError('Only the captain can reject Gate 1 in v1.');
    const candidate = this.candidate(input.directionId);
    const record: Approval = { id: `${this.options.runId}-identity-rejection-${this.approvals.length}`, stage: 'identity', approverRole: 'captain', versionId: candidate.versionId, versionHash: this.store.get(candidate.versionId)!.hash, decision: 'rejected', rationale: input.rationale, createdAt: new Date().toISOString() };
    await ignoringDuplicate(this.options.repository.createApproval({ ...record, runId: this.options.runId, projectId: this.projectId }));
    this.approvals.push(record);
    await ignoringDuplicate(this.options.repository.appendEvent({ id: randomUUID(), runId: this.options.runId, type: 'identity.gate.rejected', payload: { directionId: input.directionId, versionId: candidate.versionId } }));
    return this.snapshot();
  }

  /** Applies a token change to the approved identity, which is what reopens Gate 1. */
  async changeToken(input: { tokenPath: string; value: TokenValue; rationale: string }): Promise<IdentityRunSnapshot> {
    const changed = await this.stage.changeToken(input);
    const version = this.store.get(changed.versionId)!;
    await ignoringDuplicate(this.options.repository.saveVersion({ id: version.id, projectId: this.projectId, ...(version.parentId ? { parentId: version.parentId } : {}), hash: version.hash, ir: version.ir }));
    this.rendered.set(version.id, renderDesign(version.ir));
    // The label follows the derived gate on both outcomes: a change that restores
    // the approved identity leaves the gate closed, and the run approved with it.
    this.status = changed.gate.state === 'reopened' ? 'reopened' : 'approved';
    if (changed.gate.state === 'reopened') {
      // The renders the approved identity produced are unreachable now; drop them
      // instead of keeping screenshots of an identity nobody approved.
      if (this.options.renderCacheDir) await pruneRenderCache(this.options.renderCacheDir, changed.gate.impact.staleRenderKeys);
    }
    this.result = this.stage.snapshot();
    await this.checkpoint();
    return this.snapshot();
  }

  renderedFor(versionId: string): RenderedDocument | undefined { return this.rendered.get(versionId); }

  get projectId(): string { return this.root.ir.meta.projectId; }

  snapshot(): IdentityRunSnapshot {
    const gate = this.stage.gateState();
    const handoff = this.stage.handoff(gate);
    // Once the captain has decided, the chosen card describes the version the
    // decision lives on — the approval retires the matrix and a token change
    // moves it forward — and not the candidate it started as.
    const decided = gate.state === 'open' ? undefined : gate.record.directionId;
    return {
      runId: this.options.runId,
      projectId: this.projectId,
      status: this.status,
      baseVersionId: this.root.id,
      briefing: this.options.briefing ?? IDENTITY_BRIEFING,
      ...(this.result ? { brief: this.result.brief } : {}),
      directions: this.result ? this.result.candidates.map((candidate) => this.viewOf(candidate, decided === candidate.directionId ? this.store.get(this.stage.approvedVersionId!) : undefined)) : [],
      ...(this.result ? { divergence: { passed: this.result.divergence.passed, blockedPairs: this.result.divergence.blockedPairs, pairs: this.result.divergence.pairs.map((pair) => ({ a: pair.a, b: pair.b, distinctAxes: pair.distinctAxes, hueOnlyColor: pair.hueOnlyColor })) } } : {}),
      critiques: this.result?.critiques ?? [],
      setCritique: this.result?.setCritique ?? { scores: [], rubricGaps: [], unscoredDimensions: [], blocking: [], abstained: false },
      failures: this.result?.failures ?? [],
      gate,
      approvals: structuredClone(this.approvals),
      assets: structuredClone(this.assets),
      ...(this.stage.approvedVersionId ? { previewVersionId: this.stage.approvedVersionId } : {}),
      ...(handoff ? { handoff } : {}),
      ...(this.failure ? { error: this.failure } : {}),
    };
  }

  private candidate(directionId: string): IdentityCandidate {
    const candidate = this.result?.candidates.find((entry) => entry.directionId === directionId);
    if (!candidate) throw new StageError(`Direction ${directionId} is not one of this run's candidates.`);
    return candidate;
  }

  private async persistCandidates(result: IdentityStageResult): Promise<void> {
    for (const candidate of result.candidates) {
      for (const versionId of [candidate.refinedFromVersionId, candidate.versionId].filter((id): id is string => Boolean(id))) {
        const version = this.store.get(versionId);
        if (!version) continue;
        await ignoringDuplicate(this.options.repository.saveVersion({ id: version.id, projectId: this.projectId, ...(version.parentId ? { parentId: version.parentId } : {}), hash: version.hash, ir: version.ir }));
        this.rendered.set(version.id, renderDesign(version.ir));
      }
    }
  }

  private viewOf(candidate: IdentityCandidate, current?: VersionRecord): IdentityDirectionView {
    const identity = current?.ir.identity ?? candidate.identity;
    const lint = current ? lintDesign(current.ir) : candidate.lint;
    const swatches = [...flattenTokens(identity.tokens)]
      .filter(([path]) => path.startsWith('color.'))
      .map(([path, token]) => ({ path, value: String(token.$value) }));
    return {
      directionId: candidate.directionId,
      label: candidate.label,
      versionId: current?.id ?? candidate.versionId,
      parentVersionId: current?.parentId ?? candidate.parentVersionId,
      identityHash: current ? identityHash(current.ir) : candidate.identityHash,
      thesis: identity.direction.thesis,
      tension: identity.direction.tension,
      rationale: identity.direction.rationale,
      exclusions: identity.strategy.exclusions,
      forbiddenDefaults: identity.forbiddenDefaults,
      axes: Object.entries(candidate.vector.axes).map(([axis, value]) => ({ axis, key: value.key, descriptor: value.descriptor })),
      swatches,
      decisions: identity.decisions.map((decision) => ({ choice: decision.choice, ...(decision.axis ? { axis: decision.axis } : {}), evidenceIds: decision.evidenceIds, ...(decision.rationale ? { rationale: decision.rationale } : {}) })),
      lintErrors: lint.findings.filter((finding) => finding.severity === 'error' && finding.scope !== 'set').map((finding) => ({ id: finding.id, path: finding.path, message: finding.message })),
      blocking: candidate.blocking.map((finding) => ({ id: finding.id, observation: finding.observation, why: finding.why })),
      scores: candidate.scores,
      rubricGaps: candidate.rubricGaps,
      unscoredDimensions: candidate.unscoredDimensions,
      blockedPairs: this.stage.blockedPairsFor(candidate.directionId),
      abstained: candidate.abstained,
      ...(candidate.refinedFromVersionId ? { refinedFromVersionId: candidate.refinedFromVersionId } : {}),
      imagePlans: (candidate.imagePlan?.plans ?? []).map((plan) => ({ id: plan.id, role: plan.role, axis: plan.axis, alt: plan.alt, licenceExpectation: plan.licenceExpectation })),
      imageryViolations: candidate.imageryViolations,
    };
  }
}
