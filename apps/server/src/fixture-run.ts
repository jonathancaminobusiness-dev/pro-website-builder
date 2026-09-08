import { randomUUID } from 'node:crypto';
import { createFixtureIR, type AgentTask, type Approval } from '@pwb/domain';
import { exportStatic, type ExportManifest } from '@pwb/export';
import { lintDesign } from '@pwb/linter';
import { Applier, PatchGate, RunPlanner, Scheduler, type GateVerdict, type ScheduleResult, type VersionRecord, VersionStore } from '@pwb/orchestrator';
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
  exportManifest?: ExportManifest;
  lintErrorCount: number;
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
  private exportManifest: ExportManifest | undefined;
  private lintErrorCount = 0;
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

  constructor(private readonly options: { repository: ProjectRepository; exportRoot: string; provider: ModelProvider }) {}

  async initialize(runId: string): Promise<void> {
    this.runIdentifier = runId;
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
    this.status = this.stageIndex >= STAGES.length ? 'succeeded' : 'queued';
    this.currentStage = null;
    const events = await this.options.repository.listEvents(runId);
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

  async approve(stage: Stage, approverRole: 'captain' | string, rationale = 'Captain reviewed the typed proposal.'): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (approverRole !== 'captain') throw new Error('Only the captain can approve v1 gates.');
    if (this.status !== 'needs_review' || this.currentStage !== stage) throw new Error(`Stage ${stage} is not awaiting approval.`);
    const approved = this.currentVersion;
    const lint = lintDesign(approved.ir);
    if (lint.errorCount > 0) throw new Error(`Stage ${stage} cannot be approved while version ${approved.id} has ${lint.errorCount} lint error(s): ${lint.findings.filter((finding) => finding.severity === 'error').map((finding) => `${finding.id} ${finding.path}`).join('; ')}`);
    const approval: Approval = { id: `${this.runId()}-${stage}-approval`, stage, approverRole: 'captain', versionId: approved.id, versionHash: approved.hash, decision: 'approved', rationale, createdAt: new Date().toISOString() };
    const previousStatus = this.status;
    this.status = 'queued';
    let manifest: ExportManifest | undefined;
    try {
      manifest = stage === 'finalization' ? await exportStatic(this.rendered, approved.ir, this.options.exportRoot) : undefined;
      await ignoringDuplicate(this.options.repository.createApproval({ ...approval, runId: this.runId(), projectId: this.projectId() }));
      await this.record('approval.recorded', { stage, decision: 'approved', versionId: approval.versionId });
    } catch (error) { this.status = previousStatus; throw error; }
    this.approvals.push(approval);
    this.stageIndex += 1;
    if (manifest) { this.exportManifest = manifest; this.status = 'succeeded'; } else { this.currentStage = null; }
    this.openGate('approved');
    if (manifest) await this.record('run.finished', { status: 'succeeded', digest: manifest.digest });
    return this.snapshot();
  }

  async reject(stage: Stage, approverRole: 'captain' | string, rationale = 'Captain requested a revision.'): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (approverRole !== 'captain') throw new Error('Only the captain can reject v1 gates.');
    if (this.status !== 'needs_review' || this.currentStage !== stage) throw new Error(`Stage ${stage} is not awaiting review.`);
    const rejection: Approval = { id: `${this.runId()}-${stage}-rejection-${this.approvals.length}`, stage, approverRole: 'captain', versionId: this.currentVersion.id, versionHash: this.currentVersion.hash, decision: 'rejected', rationale, createdAt: new Date().toISOString() };
    this.approvals.push(rejection);
    this.status = 'rejected';
    const parent = this.applier.rewind(this.currentVersion);
    if (parent) {
      this.currentVersion = parent;
      this.rendered = renderDesign(parent.ir);
      this.lintErrorCount = lintDesign(parent.ir).errorCount;
    }
    await ignoringDuplicate(this.options.repository.createApproval({ ...rejection, runId: this.runId(), projectId: this.projectId() }));
    await this.record('approval.recorded', { stage, decision: 'rejected', versionId: rejection.versionId });
    if (parent) await this.record('version.rewound', { stage, rejectedVersionId: rejection.versionId, versionId: parent.id });
    return this.snapshot();
  }

  async runAll(): Promise<FixtureSnapshot> { while (this.stageIndex < 3) { await this.runNext(); if (this.status === 'cancelled') break; const stage = this.currentStage; if (!stage) throw new Error('Run did not produce a gate.'); await this.approve(stage, 'captain'); } return this.snapshot(); }

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

  snapshot(): FixtureSnapshot { this.requireInitialized(); return { runId: this.runId(), projectId: this.projectId(), status: this.status, currentStage: this.currentStage, currentVersion: structuredClone(this.currentVersion), rendered: structuredClone(this.rendered), approvals: structuredClone(this.approvals), ...(this.exportManifest ? { exportManifest: structuredClone(this.exportManifest) } : {}), lintErrorCount: this.lintErrorCount }; }

  private launch(stage: Stage): Promise<void> {
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
