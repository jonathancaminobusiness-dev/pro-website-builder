import { randomUUID } from 'node:crypto';
import { createFixtureIR, flattenTokens, type Approval, type TokenValue } from '@pwb/domain';
import { Applier, DEFAULT_MAX_ACTIVE_CLAUDE, PatchGate, Scheduler, VersionStore, type VersionRecord } from '@pwb/orchestrator';
import { HiggsfieldMcpProvider, type ModelProvider, type RasterProvider } from '@pwb/providers';
import { renderDesign, type RenderedDocument } from '@pwb/renderer';
import { approvalOf, identityHash, identityLint, identityStageDeadlineMs as calculateIdentityStageDeadlineMs, IDENTITY_STAGE_DEADLINE_CODE, IdentityStage, pruneRenderCache, resolveIdentityStageDeadlines, StageError, type IdentityAsset, type IdentityCandidate, type IdentityGateState, type IdentityHandoff, type IdentityStageDeadlines, type IdentityStageResult } from '@pwb/stage-identity';
import type { ProjectRepository } from './db/repository.js';
import { BriefingValidationError, IDENTITY_BRIEFING, INVALID_IDENTITY_BRIEFING, LEGACY_INVALID_BRIEFING_MESSAGE, normalizeIdentityBriefing } from './identity-briefing.js';
import { BriefingConversation, ConversationError } from './identity-conversation.js';

export { IDENTITY_BRIEFING } from './identity-briefing.js';

const duplicateCodes = new Set(['SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE']);
async function ignoringDuplicate(write: Promise<void>): Promise<void> {
  try { await write; } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (!duplicateCodes.has(code)) throw error;
  }
}

export type IdentityRunStatus = 'queued' | 'running' | 'needs_review' | 'approved' | 'cancelled' | 'unrecoverable' | 'reopened' | 'interrupted' | 'failed';

/**
 * The one row a restarted server rebuilds a run from. Versions, approvals and
 * events are already persisted by the rest of the product; what the stage
 * measured once and cannot measure again — the brief, the candidates, the
 * critiques and the generated assets — is written here after every step that
 * changes it, so an open Gate 1 outlives the process that opened it.
 */
const CHECKPOINT_EVENT = 'identity.run.checkpoint';
interface IdentityCheckpoint { currentVersionId?: string; assets?: IdentityAsset[]; result: IdentityStageResult }

function mergeFailures(...groups: Array<Array<{ taskId: string; reason: string }>>): Array<{ taskId: string; reason: string }> {
  const merged: Array<{ taskId: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const failure of group) {
      const key = `${failure.taskId}\u0000${failure.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...failure });
    }
  }
  return merged;
}

const INTERRUPTED = 'The server restarted while the identity stage was running, so that fan-out was lost. Start the stage again.';

const FROZEN_BRIEFING = 'A etapa de identidade desta execução já começou, então o briefing dela está congelado. Crie uma nova execução para trabalhar com um briefing diferente.';

function identityStageDeadlineMs(deadlines: Partial<IdentityStageDeadlines> | undefined, maxActiveClaude: number): number {
  const override = Number(process.env.PWB_STAGE_DEADLINE_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : calculateIdentityStageDeadlineMs(resolveIdentityStageDeadlines(deadlines), maxActiveClaude);
}

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
  private stage: IdentityStage;
  private readonly approvals: Approval[] = [];
  private readonly rendered = new Map<string, RenderedDocument>();
  private root!: VersionRecord;
  private result: IdentityStageResult | undefined;
  private restoredFailures: Array<{ taskId: string; reason: string }> = [];
  private status: IdentityRunStatus = 'queued';
  private assets: IdentityAsset[] = [];
  private failure: string | undefined;
  private started = false;
  private inFlight: Promise<void> | undefined;
  private settling: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private briefing: string;
  private readonly conversationRun: BriefingConversation;
  private readonly deadlines: IdentityStageDeadlines;

  constructor(private readonly options: { runId: string; repository: ProjectRepository; provider: ModelProvider; raster?: RasterProvider; scheduler?: Scheduler; briefing?: string; renderCacheDir?: string; deadlines?: Partial<IdentityStageDeadlines>; stageDeadlineMs?: number; modelAlias: string }) {
    this.briefing = normalizeIdentityBriefing(options.briefing);
    this.conversationRun = new BriefingConversation({
      runId: options.runId,
      provider: options.provider,
      persist: async (snapshot, confirmedBriefing) => { await options.repository.saveConversation(options.runId, JSON.stringify(snapshot), confirmedBriefing); },
      // No turn is bought on an execution that could never take its answer, and
      // the same rule is asked again inside the section the confirmation writes
      // and applies in — the section `start` also takes to claim the stage. A
      // turn takes up to a minute and the captain can start the stage inside
      // it, so the second ask is not redundant with the first: it is the one
      // that protects a running fan-out from being replaced under it.
      confirmSection: (work) => this.exclusive(work),
      guardTurn: (turn) => {
        this.refuseIfTerminal('create another one to work on a briefing.');
        if (!turn.cancelling && this.briefingIsFrozen()) throw new ConversationError(FROZEN_BRIEFING, 409);
      },
      onConfirmed: (briefing) => {
        this.briefing = briefing;
        this.stage = this.newStage();
      },
      initialText: () => this.briefing,
    });
    this.deadlines = resolveIdentityStageDeadlines(options.deadlines);
    const ir = createFixtureIR();
    this.root = new Applier(this.store, new PatchGate()).createRoot(ir);
    this.rendered.set(this.root.id, renderDesign(this.root.ir));
    this.stage = this.newStage();
  }

  /**
   * A stage runs once. Trying again after a failure needs a fresh one, with its
   * own patch gate per branch, exactly as a restarted process builds: the
   * version store is shared, so a direction the first attempt did produce is
   * recognised rather than written twice.
   */
  private newStage(): IdentityStage {
    return new IdentityStage({
      runId: this.options.runId,
      baseVersionId: this.root.id,
      briefing: this.briefing,
      provider: this.options.provider,
      modelAlias: this.options.modelAlias,
      store: this.store,
      ...(this.options.scheduler ? { scheduler: this.options.scheduler } : {}),
      deadlines: this.deadlines,
      raster: this.options.raster ?? new HiggsfieldMcpProvider({ configured: false }),
      onEvent: (type, payload) => ignoringDuplicate(this.options.repository.appendEvent({ id: randomUUID(), runId: this.options.runId, type, payload })),
    });
  }

  async initialize(): Promise<void> {
    await ignoringDuplicate(this.options.repository.createProject({ id: this.projectId, name: 'Identity stage project' }));
    await ignoringDuplicate(this.options.repository.createRun({ id: this.options.runId, projectId: this.projectId, briefing: this.briefing }));
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
    let briefing: string;
    try {
      briefing = normalizeIdentityBriefing(run.briefing);
    } catch (error) {
      if (!(error instanceof BriefingValidationError)) throw error;
      this.status = 'unrecoverable';
      this.started = true;
      this.briefing = INVALID_IDENTITY_BRIEFING;
      this.failure = LEGACY_INVALID_BRIEFING_MESSAGE;
      return true;
    }
    this.briefing = briefing;
    // Canonicalizing the stored row is a convenience, not a precondition for
    // reading the run: the normalized briefing is already the one in memory, so
    // a write this process cannot do now is left to a later restore.
    if (briefing !== run.briefing) await this.options.repository.updateRunBriefing(this.options.runId, briefing).catch(() => undefined);
    // The conversation is rebuilt from the execution before anything else reads
    // it, so a restarted server serves the same transcript, state and summary.
    this.conversationRun.restore(run.conversation);
    this.stage = this.newStage();
    for (const version of await this.options.repository.listVersions(run.projectId)) {
      if (this.store.get(version.id)) continue;
      this.store.save({ id: version.id, ...(version.parentId ? { parentId: version.parentId } : {}), hash: version.hash, ir: version.ir });
    }
    this.approvals.push(...await this.options.repository.listApprovals(this.options.runId));
    const events = await this.options.repository.listEvents(this.options.runId);
    const lastStageStart = events.reduce((index, event, current) => event.type === 'identity.stage.started' ? current : index, -1);
    this.restoredFailures = events.slice(lastStageStart >= 0 ? lastStageStart : 0).flatMap((event) => {
      if (event.type !== 'identity.task.failed') return [];
      const taskId = event.payload.taskId;
      const reason = event.payload.reason;
      return typeof taskId === 'string' && typeof reason === 'string' ? [{ taskId, reason }] : [];
    });
    // A stop is written to the ledger, so it is read back from it: a run the
    // captain ended is still ended in a process that never saw the request.
    const cancelled = events.some((event) => event.type === 'identity.run.cancelled');
    const checkpoint = events.filter((event) => event.type === CHECKPOINT_EVENT).at(-1);
    if (!checkpoint) {
      if (cancelled) { this.status = 'cancelled'; this.started = true; return true; }
      // A run can be started again after it failed, so what it ended as is
      // whichever of the two events came last, not whether a failure is present.
      const last = events.filter((event) => event.type === 'identity.stage.failed' || event.type === 'identity.stage.started').at(-1);
      const failed = last?.type === 'identity.stage.failed' ? last : undefined;
      if (failed) this.failure = typeof failed.payload.reason === 'string' ? failed.payload.reason : 'The identity stage failed.';
      else if (last) this.failure = INTERRUPTED;
      this.status = failed ? 'failed' : this.failure ? 'interrupted' : 'queued';
      return true;
    }
    const state = checkpoint.payload as unknown as IdentityCheckpoint;
    this.stage.restore({ result: state.result, ...(state.currentVersionId ? { currentVersionId: state.currentVersionId } : {}), assets: state.assets ?? [] });
    this.result = this.stage.snapshot();
    // The stage settles what the ended process left in flight, so the snapshot
    // reads what became of every image rather than one that never finishes.
    this.assets = this.stage.approvedImagery;
    // The label is derived from the gate, exactly as it is on the live path,
    // unless the captain ended the run: that decision outranks the gate.
    const gate = this.result.gate;
    this.status = cancelled ? 'cancelled' : gate.state === 'closed' ? 'approved' : gate.state === 'reopened' ? 'reopened' : 'needs_review';
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

  /**
   * Everything that decides which briefing this execution runs on, one at a
   * time: the claim a start makes on the stage, and the write-and-apply of a
   * confirmation. Holding them apart is what makes the freeze meaningful — a
   * start that reads `briefingIsFrozen() === false` can no longer slip between
   * that answer and the briefing being applied.
   */
  private lane: Promise<unknown> = Promise.resolve();

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lane.then(work, work);
    this.lane = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * The one entry point that spends model turns. Nothing else in this class
   * starts a worker.
   *
   * It answers as soon as the fan-out is under way, with the `running`
   * snapshot, and never holds its caller for the stage deadline — which is
   * counted in tens of minutes, far beyond any HTTP client's patience. What the
   * stage becomes is read from the snapshot, through the polling the studio
   * already does. The claim itself is taken on the exclusive lane, so a
   * confirmation can neither slip between the freeze answer and this claim nor
   * replace the stage this one is about to run.
   */
  async begin(): Promise<IdentityRunSnapshot> {
    this.refuseIfTerminal('create another one to run the identity stage.');
    await this.exclusive(async () => {
      // A failure is not the end of the run: the captain can ask again here, on
      // the same terms a restarted process already offers.
      if (this.status === 'failed' || this.status === 'interrupted') { this.started = false; this.result = undefined; this.restoredFailures = []; this.stage = this.newStage(); }
      if (this.started) return;
      this.started = true;
      this.status = 'running';
      this.abort = new AbortController();
      this.failure = undefined;
      this.inFlight = this.runStage(this.abort.signal).then(async (result) => {
        this.result = result;
        await this.persistCandidates(result);
        this.status = 'needs_review';
        await this.checkpoint();
      }).catch(async (error: unknown) => {
        // A run that failed holds nothing: the partial result goes with the
        // stage it came from, so the snapshot never shows directions no gate
        // can decide and the briefing is free again.
        this.result = undefined;
        this.failure = error instanceof Error ? error.message : 'The identity stage failed.';
        this.status = 'failed';
        await ignoringDuplicate(this.options.repository.appendEvent({ id: randomUUID(), runId: this.options.runId, type: 'identity.stage.failed', payload: { reason: this.failure } }));
      }).catch(() => undefined);
    });
    return this.snapshot();
  }

  /** Starts the stage and waits for it, for callers that own the process rather than an HTTP response. */
  async start(): Promise<IdentityRunSnapshot> {
    await this.begin();
    await this.inFlight;
    return this.snapshot();
  }

  private async runStage(signal: AbortSignal): Promise<IdentityStageResult> {
    const deadlineMs = this.options.stageDeadlineMs ?? identityStageDeadlineMs(this.deadlines, this.options.scheduler?.maxActiveClaude ?? DEFAULT_MAX_ACTIVE_CLAUDE);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlineError = new Error(`The identity stage exceeded its ${deadlineMs}ms deadline.`);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Carry the deadline through the signal so the stage can stop at its
        // next phase boundary. A plain abort is reserved for captain stops,
        // whose existing contract keeps an already-built fan-out reviewable.
        this.abort?.abort({ code: IDENTITY_STAGE_DEADLINE_CODE, error: deadlineError });
        reject(deadlineError);
      }, deadlineMs);
    });
    try {
      return await Promise.race([this.stage.run(signal), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The briefing is frozen exactly while the execution holds identity work made
   * from it: a fan-out in flight, or one whose checkpoint the run carries. Both
   * facts survive a restart — `restore` rebuilds the checkpoint and a lost
   * fan-out comes back as `interrupted` — so the same execution answers a
   * confirmation the same way before and after the process bounced. A stage
   * that failed or was interrupted froze nothing: it discards its result, so
   * the captain may confirm a new briefing and start again on it. A result the
   * run still holds counts as started whatever the status says, which is the
   * guard that survives a failure path that forgot to discard one.
   */
  private briefingIsFrozen(): boolean {
    if (this.result !== undefined) return true;
    if (this.status === 'failed' || this.status === 'interrupted') return false;
    return this.status === 'running';
  }

  /**
   * Nothing is decided on a run the captain stopped, and no turn is spent on
   * one either. Every route that would write to its ledger asks here, so the
   * rule has one definition rather than a copy per route.
   */
  private refuseIfTerminal(what: string): void {
    this.refuseIfUnrecoverable();
    if (this.status === 'cancelled') throw new StageError(`This run was cancelled; ${what}`);
  }

  /**
   * A legacy run whose persisted briefing is invalid has nothing to decide and
   * nothing to stop, so every route refuses it. Stopping a run the captain
   * already stopped stays the idempotent no-op it has always been.
   */
  private refuseIfUnrecoverable(): void {
    if (this.status === 'unrecoverable') throw new StageError(this.failure ?? LEGACY_INVALID_BRIEFING_MESSAGE);
  }

  async cancel(): Promise<IdentityRunSnapshot> {
    this.refuseIfUnrecoverable();
    // What the stop is worth is decided before anything is awaited: a fan-out
    // that had already produced its result is the most expensive artefact in
    // the run, and awaiting first would let it finish and be discarded anyway.
    const interrupted = this.result === undefined;
    this.abort?.abort();
    await this.inFlight;
    // Imagery outlives the approve call, so cancelling the run has to reach it
    // too; what it did not finish stays recorded as a failed asset.
    await this.stage.cancelImagery();
    await this.settling;
    // A run that has candidates to decide, or a decision already recorded,
    // survives its stop: the imagery is dropped and the gate stays open for the
    // captain. Only work that never got that far ends as a cancelled run, and a
    // run that survives gets a fresh scope for what comes next.
    if (!interrupted || this.stage.gateState().state !== 'open') { this.abort = new AbortController(); return this.snapshot(); }
    this.status = 'cancelled';
    this.failure = undefined;
    await ignoringDuplicate(this.options.repository.appendEvent({ id: randomUUID(), runId: this.options.runId, type: 'identity.run.cancelled', payload: { runId: this.options.runId } }));
    return this.snapshot();
  }

  async approve(input: { directionId: string; approverRole: string; rationale: string; overrideRationale?: string }): Promise<IdentityRunSnapshot> {
    this.refuseIfTerminal('Gate 1 cannot be decided on it.');
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
    this.refuseIfTerminal('Gate 1 cannot be decided on it.');
    const candidate = this.candidate(input.directionId);
    const record: Approval = { id: `${this.options.runId}-identity-rejection-${this.approvals.length}`, stage: 'identity', approverRole: 'captain', versionId: candidate.versionId, versionHash: this.store.get(candidate.versionId)!.hash, decision: 'rejected', rationale: input.rationale, createdAt: new Date().toISOString() };
    await ignoringDuplicate(this.options.repository.createApproval({ ...record, runId: this.options.runId, projectId: this.projectId }));
    this.approvals.push(record);
    await ignoringDuplicate(this.options.repository.appendEvent({ id: randomUUID(), runId: this.options.runId, type: 'identity.gate.rejected', payload: { directionId: input.directionId, versionId: candidate.versionId } }));
    return this.snapshot();
  }

  /** Applies a token change to the approved identity, which is what reopens Gate 1. */
  async changeToken(input: { tokenPath: string; value: TokenValue; rationale: string }): Promise<IdentityRunSnapshot> {
    this.refuseIfUnrecoverable();
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

  /** The briefing conversation this execution carries; the API's three conversation routes are its only callers. */
  get conversation(): BriefingConversation { return this.conversationRun; }

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
      briefing: this.briefing,
      ...(this.result ? { brief: this.result.brief } : {}),
      directions: this.result ? this.result.candidates.map((candidate) => this.viewOf(candidate, decided === candidate.directionId ? this.store.get(this.stage.approvedVersionId!) : undefined)) : [],
      ...(this.result ? { divergence: { passed: this.result.divergence.passed, blockedPairs: this.result.divergence.blockedPairs, pairs: this.result.divergence.pairs.map((pair) => ({ a: pair.a, b: pair.b, distinctAxes: pair.distinctAxes, hueOnlyColor: pair.hueOnlyColor })) } } : {}),
      critiques: this.result?.critiques ?? [],
      setCritique: this.result?.setCritique ?? { scores: [], rubricGaps: [], unscoredDimensions: [], blocking: [], abstained: false },
      failures: mergeFailures(this.result?.failures ?? [], this.restoredFailures, this.stage.recordedFailures),
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
    const lint = current ? identityLint(current.ir) : candidate.lint;
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
