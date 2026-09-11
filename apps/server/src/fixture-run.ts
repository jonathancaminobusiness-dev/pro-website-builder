import { randomUUID } from 'node:crypto';
import { createFixtureIR, type AgentTask, type Approval } from '@pwb/domain';
import type { ReleaseManifest } from '@pwb/export';
import { lintDesign } from '@pwb/linter';
import { Applier, PatchGate, RunPlanner, Scheduler, type GateVerdict, type ScheduleResult, type VersionRecord, VersionStore } from '@pwb/orchestrator';
import { ReleaseRun, type ReleaseApprover, type ReleaseContext, type ReleaseRunOptions, type ReleaseSnapshot } from './release-run.js';
import type { ModelProvider } from '@pwb/providers';
import { renderDesign, type RenderedDocument } from '@pwb/renderer';
import type { ProjectRepository } from './db/repository.js';

type Stage = 'identity' | 'prototype' | 'finalization';
type FixtureStatus = 'queued' | 'needs_review' | 'rejected' | 'cancelled' | 'succeeded' | 'failed';

const BRIEF = 'Fixture briefing: compile an original identity into a production site.';
const STAGES: Stage[] = ['identity', 'prototype', 'finalization'];
const duplicateCodes = new Set(['SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE']);
async function ignoringDuplicate(write: Promise<void>): Promise<void> {
  try { await write; } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (!duplicateCodes.has(code)) throw error;
  }
}

export interface FixtureSnapshot {
  runId: string;
  projectId: string;
  status: FixtureStatus;
  currentStage: Stage | null;
  currentVersion: VersionRecord;
  rendered: RenderedDocument;
  approvals: Approval[];
  exportManifest?: ReleaseManifest;
  lintErrorCount: number;
  /**
   * The stage whose undecided proposal a restart discarded, when a restore
   * rewound the head to the last version the captain approved. The captain is
   * told the work is gone instead of reading a rewound document as progress.
   */
  discardedStage?: Stage;
}

export class FixtureRun {
  private readonly store = new VersionStore();
  private readonly applier = new Applier(this.store, new PatchGate());
  private readonly planner = new RunPlanner(this.store);
  private readonly scheduler = new Scheduler();
  private readonly approvals: Approval[] = [];
  private currentVersion!: VersionRecord;
  private rendered!: RenderedDocument;
  private currentStage: Stage | null = null;
  private stageIndex = 0;
  private status: FixtureStatus = 'queued';
  private exportManifest: ReleaseManifest | undefined;
  private lintErrorCount = 0;
  private discardedStage: Stage | undefined;
  private initialized = false;
  private started = false;
  private statusBeforeCancel: FixtureStatus = 'queued';
  private runIdentifier = '';
  private runAbort: AbortController | undefined;
  private scheduled: Promise<void> | undefined;
  private gate: ((verdict: GateVerdict) => void) | undefined;
  private pendingVerdict: GateVerdict | undefined;
  private waiters: Array<() => void> = [];
  private failure: unknown;
  private running = false;
  private readonly attempts = new Map<Stage, number>();
  private readonly reported = new Set<string>();

  /**
   * The release refiner writes through the run's own versions, but never shares
   * the stage gate's compare-and-swap bookkeeping: it proposes against the
   * version the finalization stage produced, which that gate already patched.
   */
  private releaseGate = new PatchGate();
  private finalizationVersion: VersionRecord | undefined;

  private releaseRun: ReleaseRun | undefined;

  constructor(private readonly options: { repository: ProjectRepository; provider: ModelProvider; release?: ReleaseRunOptions }) {}

  async initialize(runId: string): Promise<void> {
    this.runIdentifier = runId;
    if (this.options.release) this.releaseRun = new ReleaseRun(runId, this.options.release);
    const ir = createFixtureIR();
    await ignoringDuplicate(this.options.repository.createProject({ id: ir.meta.projectId, name: 'Fixture project' }));
    await ignoringDuplicate(this.options.repository.createRun({ id: runId, projectId: ir.meta.projectId }));
    this.currentVersion = this.applier.createRoot(ir);
    await ignoringDuplicate(this.options.repository.saveVersion({ id: this.currentVersion.id, projectId: ir.meta.projectId, hash: this.currentVersion.hash, ir: this.currentVersion.ir }));
    this.rendered = renderDesign(ir);
    this.initialized = true;
    await this.record('run.created', { projectId: ir.meta.projectId, versionId: this.currentVersion.id });
    await this.record('version.created', { versionId: this.currentVersion.id, hash: this.currentVersion.hash });
  }

  /** Rebuilds a persisted run so a restarted server can serve, preview and continue it. */
  async restore(runId: string): Promise<boolean> {
    const run = await this.options.repository.getRun(runId);
    if (!run) return false;
    const versions = await this.options.repository.listVersions(run.projectId);
    if (versions.length === 0) return false;
    this.runIdentifier = runId;
    if (this.options.release) this.releaseRun = new ReleaseRun(runId, this.options.release);
    const byId = new Map(versions.map((version) => [version.id, version]));
    for (const version of versions) this.store.save({ id: version.id, ...(version.parentId ? { parentId: version.parentId } : {}), hash: version.hash, ir: version.ir });
    const approvals = await this.options.repository.listApprovals(runId);
    const approved = approvals.filter((approval) => approval.decision === 'approved');
    const head = approved.at(-1) ? byId.get(approved.at(-1)!.versionId) : versions.find((version) => !version.parentId);
    if (!head) return false;
    this.currentVersion = { id: head.id, ...(head.parentId ? { parentId: head.parentId } : {}), hash: head.hash, ir: head.ir };
    this.rendered = renderDesign(head.ir);
    this.lintErrorCount = lintDesign(head.ir).errorCount;
    this.approvals.push(...approvals);
    this.stageIndex = Math.min(approved.length, STAGES.length);
    const events = await this.options.repository.listEvents(runId);
    // The project holds every run's versions, so what this run left undecided is
    // read from its own log, in order: a proposal it made on the head it still
    // holds is pending until a rejection retires it, and a rerun proposes again.
    const undecided = new Set<string>();
    for (const event of events) {
      if (event.type === 'version.created' && byId.get(String(event.payload.versionId))?.parentId === head.id) undecided.add(String(event.payload.versionId));
      if (event.type === 'version.rewound') { undecided.delete(String(event.payload.rejectedVersionId)); undecided.delete(String(event.payload.retiredVersionId)); }
    }
    this.discardedStage = undecided.size > 0 ? STAGES[this.stageIndex] : undefined;
    this.status = this.stageIndex >= STAGES.length ? 'succeeded' : 'queued';
    this.currentStage = null;
    this.started = events.some((event) => event.type === 'run.started');
    for (const event of events) if (event.type === 'task.queued') this.attempts.set(event.payload.stage as Stage, Number(event.payload.attempt));
    this.initialized = true;
    return true;
  }

  async runNext(): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (this.status === 'succeeded' || this.status === 'cancelled' || this.status === 'needs_review') return this.snapshot();
    const stage = STAGES[this.stageIndex];
    if (!stage) return this.snapshot();
    this.failure = undefined;
    const parked = this.scheduled !== undefined && (this.running || this.gate !== undefined);
    if (this.status === 'rejected' && this.gate) this.openGate('rejected');
    const inFlight = parked ? this.scheduled! : this.launch(stage);
    await Promise.race([this.settled(), inFlight]);
    const failure = this.failure;
    this.failure = undefined;
    if (failure) await inFlight.catch(() => undefined);
    const settled = this.snapshot();
    if (failure && settled.status !== 'cancelled') throw failure;
    return settled;
  }

  /**
   * Closes the identity and prototype gates. The finalization gate is Gate 3:
   * publishing its bundle is the approval, so there is no second action that
   * could approve the stage without the gate's verdict.
   */
  async approve(stage: Stage, approverRole: 'captain' | string, rationale = 'Captain reviewed the typed proposal.'): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (approverRole !== 'captain') throw new Error('Only the captain can approve v1 gates.');
    if (stage === 'finalization') throw new Error('O gate de finalização é o Gate 3: publicar o bundle aprova a etapa.');
    if (this.status !== 'needs_review' || this.currentStage !== stage) throw new Error(`Stage ${stage} is not awaiting approval.`);
    const approved = this.currentVersion;
    this.requireClean(stage, approved);
    const approval: Approval = { id: `${this.runId()}-${stage}-approval`, stage, approverRole: 'captain', versionId: approved.id, versionHash: approved.hash, decision: 'approved', rationale, createdAt: new Date().toISOString() };
    const previousStatus = this.status;
    this.status = 'queued';
    try {
      await ignoringDuplicate(this.options.repository.createApproval({ ...approval, runId: this.runId(), projectId: this.projectId() }));
      await this.record('approval.recorded', { stage, decision: 'approved', versionId: approval.versionId });
    } catch (error) { this.status = previousStatus; throw error; }
    this.approvals.push(approval);
    this.stageIndex += 1;
    this.currentStage = null;
    this.openGate('approved');
    return this.snapshot();
  }

  releaseEnabled(): boolean { return this.releaseRun !== undefined; }
  releaseSnapshot(): ReleaseSnapshot | undefined { return this.releaseRun?.snapshot(); }

  async prepareRelease(signal?: AbortSignal): Promise<ReleaseSnapshot> {
    this.requireInitialized();
    if (!this.releaseRun) throw new Error('A finalização não está habilitada nesta execução.');
    return this.releaseRun.prepare(this.releaseContext(), signal);
  }

  /**
   * Publishing the bundle the captain looked at is what closes the finalization
   * gate. The bundle has to come from a release prepared for the proposal now at
   * the gate, and the gate is claimed before the first await, so two publishes
   * that race cannot both write the bundle and record the approval.
   */
  async publishRelease(digest: string, rationale?: string, approverRole: ReleaseApprover = 'captain'): Promise<ReleaseManifest> {
    this.requireInitialized();
    if (!this.releaseRun) throw new Error('A finalização não está habilitada nesta execução.');
    if (this.status !== 'needs_review' || this.currentStage !== 'finalization') throw new Error('Stage finalization is not awaiting approval.');
    this.requireClean('finalization', this.currentVersion);
    if (this.releaseRun.snapshot()?.refinedFromVersionId !== this.finalizationVersion?.id) throw new Error('O release preparado não é o da proposta que está no gate; prepare o release novamente antes de publicar.');
    this.status = 'queued';
    try { return await this.releaseRun.publish(approverRole, digest, rationale); }
    catch (error) { if (this.status === 'queued') this.status = 'needs_review'; throw error; }
  }

  /** No gate closes over a document the linter rejects, Gate 3 included. */
  private requireClean(stage: Stage, version: VersionRecord): void {
    const lint = lintDesign(version.ir);
    if (lint.errorCount > 0) throw new Error(`Stage ${stage} cannot be approved while version ${version.id} has ${lint.errorCount} lint error(s): ${lint.findings.filter((finding) => finding.severity === 'error').map((finding) => `${finding.id} ${finding.path}`).join('; ')}`);
  }

  async reject(stage: Stage, approverRole: 'captain' | string, rationale = 'Captain requested a revision.'): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (approverRole !== 'captain') throw new Error('Only the captain can reject v1 gates.');
    if (this.status !== 'needs_review' || this.currentStage !== stage) throw new Error(`Stage ${stage} is not awaiting review.`);
    const rejection: Approval = { id: `${this.runId()}-${stage}-rejection-${this.approvals.length}`, stage, approverRole: 'captain', versionId: this.currentVersion.id, versionHash: this.currentVersion.hash, decision: 'rejected', rationale, createdAt: new Date().toISOString() };
    this.approvals.push(rejection);
    this.status = 'rejected';
    // Gate 3 may have adopted a refinement on top of what the stage produced, so
    // the rewind starts from the stage's own version and lands on its base.
    const rejected = stage === 'finalization' && this.finalizationVersion ? this.finalizationVersion : this.currentVersion;
    const parent = this.applier.rewind(rejected);
    if (stage === 'finalization') { this.finalizationVersion = undefined; this.discardPreparedRelease(); }
    if (parent) {
      this.currentVersion = parent;
      this.rendered = renderDesign(parent.ir);
      this.lintErrorCount = lintDesign(parent.ir).errorCount;
    }
    await ignoringDuplicate(this.options.repository.createApproval({ ...rejection, runId: this.runId(), projectId: this.projectId() }));
    await this.record('approval.recorded', { stage, decision: 'rejected', versionId: rejection.versionId });
    if (parent) await this.record('version.rewound', { stage, rejectedVersionId: rejection.versionId, retiredVersionId: rejected.id, versionId: parent.id });
    return this.snapshot();
  }

  /**
   * Walks the fixture to Gate 3 and prepares the release, stopping there. A
   * script never publishes on the captain's behalf: the caller reads the report
   * and decides, and only a release the gate left nothing to accept for may be
   * published under the `fixture` role.
   */
  async runAll(): Promise<FixtureSnapshot> {
    while (this.stageIndex < 3) {
      await this.runNext();
      if (this.status === 'cancelled') break;
      const stage = this.currentStage;
      if (!stage) throw new Error('Run did not produce a gate.');
      if (stage === 'finalization') { await this.prepareRelease(); break; }
      await this.approve(stage, 'captain');
    }
    return this.snapshot();
  }

  async cancel(): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (this.status === 'succeeded' || this.status === 'cancelled') return this.snapshot();
    this.statusBeforeCancel = this.status;
    this.status = 'cancelled';
    this.runAbort?.abort();
    this.openGate('cancelled');
    await this.record('run.cancelled', { status: this.statusBeforeCancel, stage: this.currentStage });
    return this.snapshot();
  }

  async restart(): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (this.status !== 'cancelled') return this.snapshot();
    await this.scheduled;
    this.status = this.statusBeforeCancel;
    this.failure = undefined;
    await this.record('run.restarted', { status: this.status, stage: this.currentStage });
    return this.snapshot();
  }

  snapshot(): FixtureSnapshot { this.requireInitialized(); return { runId: this.runId(), projectId: this.projectId(), status: this.status, currentStage: this.currentStage, currentVersion: structuredClone(this.currentVersion), rendered: structuredClone(this.rendered), approvals: structuredClone(this.approvals), ...(this.exportManifest ? { exportManifest: structuredClone(this.exportManifest) } : {}), lintErrorCount: this.lintErrorCount, ...(this.discardedStage ? { discardedStage: this.discardedStage } : {}) }; }

  /**
   * Why Gate 3 may not run yet, or nothing when it may.
   *
   * The plan closes three gates in order: a release is only ever compiled after
   * the captain approved identity and prototype, and only from what the
   * finalization stage produced for them to look at. Publishing the bundle
   * closes this gate, and a closed gate does not reopen: preparing again would
   * move the document of a run that already finished.
   */
  releaseBlocker(): string | undefined {
    this.requireInitialized();
    for (const stage of ['identity', 'prototype'] as const) {
      if (!this.approvedAt(stage)) return `O gate de release exige a aprovação do capitão na etapa de ${stage === 'identity' ? 'identidade' : 'protótipo'} desta execução.`;
    }
    if (!this.finalizationVersion) return 'A etapa de finalização ainda não produziu a versão que o gate de release compila.';
    if (this.status !== 'needs_review' || this.currentStage !== 'finalization') return 'O gate de finalização não está aberto: o release só é preparado e publicado enquanto a etapa aguarda a decisão do capitão.';
    return undefined;
  }

  /**
   * The one document this run releases: what the finalization stage produced,
   * plus the review record the refiner wrote onto it. Gate 3 and the ordinary
   * finalization approval compile exactly this, so the approval, the manifest
   * and the published bytes always name the same version.
   */
  releaseContext(): ReleaseContext {
    const blocker = this.releaseBlocker();
    if (blocker) throw new Error(blocker);
    const approved = this.finalizationVersion!;
    return {
      approved,
      current: this.currentVersion,
      applier: new Applier(this.store, this.releaseGate),
      record: (type, payload) => this.record(type, payload),
      approveFinalization: async (approverRole, rationale, manifest) => {
        const version = this.currentVersion;
        const approval: Approval = { id: `${this.runId()}-finalization-approval`, stage: 'finalization', approverRole, versionId: version.id, versionHash: version.hash, decision: 'approved', rationale, createdAt: new Date().toISOString() };
        this.approvals.push(approval);
        this.stageIndex += 1;
        this.exportManifest = manifest;
        this.status = 'succeeded';
        this.openGate('approved');
        await ignoringDuplicate(this.options.repository.createApproval({ ...approval, runId: this.runId(), projectId: this.projectId() }));
        await this.record('approval.recorded', { stage: 'finalization', decision: 'approved', versionId: approval.versionId });
        await this.record('run.finished', { status: 'succeeded', digest: manifest.digest });
      },
      adopt: async (version) => {
        if (this.status !== 'needs_review' || this.currentStage !== 'finalization') throw new Error('O gate de finalização se moveu enquanto o release era preparado; a preparação não adota a versão refinada.');
        this.currentVersion = version;
        this.rendered = renderDesign(version.ir);
        this.lintErrorCount = lintDesign(version.ir).errorCount;
        await ignoringDuplicate(this.options.repository.saveVersion({ id: version.id, projectId: this.projectId(), ...(version.parentId ? { parentId: version.parentId } : {}), hash: version.hash, ir: version.ir }));
        await this.record('version.created', { versionId: version.id, hash: version.hash });
      },
    };
  }

  /**
   * A prepared release belongs to one finalization proposal, and so does the
   * compare-and-swap bookkeeping its refinement left behind: both are discarded
   * as one unit, so the next proposal is refined from a clean gate.
   */
  private discardPreparedRelease(): void {
    this.releaseGate = new PatchGate();
    if (this.options.release) this.releaseRun = new ReleaseRun(this.runIdentifier, this.options.release);
  }

  private approvedAt(stage: Stage): Approval | undefined {
    return [...this.approvals].reverse().find((entry) => entry.stage === stage && entry.decision === 'approved');
  }

  private launch(stage: Stage): Promise<void> {
    this.discardedStage = undefined;
    const plan = this.planner.plan(this.runId(), this.currentVersion.id, BRIEF);
    const controller = new AbortController();
    this.runAbort = controller;
    const planned = plan.tasks.find((task) => task.stage === stage)!;
    const queued = [{ ...planned, attempt: (this.attempts.get(stage) ?? 0) + 1 }];
    const absorbed = this.scheduler
      .run(queued, (task, signal) => this.executeStage(task, signal), {
        signal: controller.signal,
        edges: plan.edges,
        completed: this.approvals.filter((entry) => entry.decision === 'approved').map((entry) => `task-${entry.stage}`),
        settle: (_task, _value, signal) => this.awaitGate(signal),
      })
      .then((result) => this.absorb(result));
    const scheduled: Promise<void> = absorbed.finally(() => { if (this.scheduled === scheduled) { this.runAbort = undefined; this.scheduled = undefined; } });
    this.scheduled = scheduled;
    return scheduled;
  }

  private async absorb(result: ScheduleResult<VersionRecord>): Promise<void> {
    for (const entry of result.results) {
      if (entry.state !== 'failed') continue;
      const key = `${entry.task.id}#${entry.task.attempt}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      await this.record('task.failed', { taskId: entry.task.id, stage: entry.task.stage, attempt: entry.task.attempt, reason: entry.error instanceof Error ? entry.error.message : 'The stage did not produce a proposal.' });
      this.failure = entry.error;
      if (this.status !== 'cancelled') this.status = 'failed';
    }
  }

  private async executeStage(task: AgentTask, signal: AbortSignal): Promise<VersionRecord> {
    this.pendingVerdict = undefined;
    this.running = true;
    try {
      const plan = this.planner.plan(this.runId(), this.currentVersion.id, BRIEF);
      const current = { ...plan.tasks.find((item) => item.id === task.id)!, attempt: task.attempt };
      this.currentStage = current.stage;
      this.attempts.set(current.stage, current.attempt);
      await ignoringDuplicate(this.options.repository.saveTask(current, this.runId()));
      await this.record('task.queued', { taskId: current.id, stage: current.stage, attempt: current.attempt, baseVersionId: current.baseVersionId });
      if (!this.started) { this.started = true; await this.record('run.started', { stage: current.stage }); }
      await this.record('task.started', { taskId: current.id, stage: current.stage, attempt: current.attempt });
      const outcome = await this.options.provider.propose(current, signal);
      const proposal = outcome.proposal;
      if (!proposal) {
        const reason = outcome.summary || 'The stage produced no proposal.';
        this.reported.add(`${current.id}#${current.attempt}`);
        await this.record('task.failed', { taskId: current.id, stage: current.stage, attempt: current.attempt, reason });
        if (this.status !== 'cancelled') this.status = 'failed';
        throw new Error(`Stage ${current.stage} produced no proposal: ${reason}`);
      }
      let next: VersionRecord;
      try {
        renderDesign(this.applier.dryRun(proposal, current, this.currentVersion.id).next);
        next = this.applier.apply(proposal, current, this.currentVersion.id);
      } catch (error) {
        this.reported.add(`${current.id}#${current.attempt}`);
        await this.record('task.failed', { taskId: current.id, stage: current.stage, attempt: current.attempt, reason: error instanceof Error ? error.message : 'The proposal did not validate.' });
        throw error;
      }
      await ignoringDuplicate(this.options.repository.savePatch(proposal, this.runId()));
      await ignoringDuplicate(this.options.repository.saveVersion({ id: next.id, projectId: this.projectId(), ...(next.parentId ? { parentId: next.parentId } : {}), hash: next.hash, ir: next.ir }));
      this.currentVersion = next;
      if (current.stage === 'finalization') { this.finalizationVersion = next; this.discardPreparedRelease(); }
      this.rendered = renderDesign(next.ir);
      this.lintErrorCount = lintDesign(next.ir).errorCount;
      await this.record('patch.applied', { taskId: current.id, stage: current.stage, baseVersionId: current.baseVersionId, versionId: next.id });
      await this.record('version.created', { versionId: next.id, hash: next.hash });
      await this.record('task.succeeded', { taskId: current.id, stage: current.stage, versionId: next.id });
      if (this.status === 'cancelled') this.statusBeforeCancel = 'needs_review';
      else this.status = 'needs_review';
      return next;
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      this.running = false;
      this.notify();
    }
  }

  private awaitGate(signal: AbortSignal): Promise<GateVerdict> {
    if (signal.aborted || this.status === 'cancelled') { this.pendingVerdict = undefined; return Promise.resolve('cancelled'); }
    const decided = this.pendingVerdict;
    if (decided) { this.pendingVerdict = undefined; return Promise.resolve(decided); }
    return new Promise((resolve) => {
      this.gate = resolve;
      signal.addEventListener('abort', () => this.openGate('cancelled'), { once: true });
    });
  }

  private openGate(verdict: GateVerdict): void { const gate = this.gate; this.gate = undefined; if (gate) gate(verdict); else this.pendingVerdict = verdict; }
  private settled(): Promise<void> { return new Promise((resolve) => { this.waiters.push(resolve); }); }
  private notify(): void { const waiters = this.waiters; this.waiters = []; for (const waiter of waiters) waiter(); }
  private async record(type: string, payload: Record<string, unknown>): Promise<void> { await this.options.repository.appendEvent({ id: randomUUID(), runId: this.runId(), type, payload }); }
  private runId(): string { return this.runIdentifier; }
  private projectId(): string { return this.currentVersion.ir.meta.projectId; }
  private requireInitialized(): void { if (!this.initialized) throw new Error('Fixture run is not initialized.'); }
}
