import { randomUUID } from 'node:crypto';
import { createFixtureIR, type Approval } from '@pwb/domain';
import { exportStatic, type ExportManifest } from '@pwb/export';
import { lintDesign } from '@pwb/linter';
import { Applier, PatchGate, RunPlanner, Scheduler, type VersionRecord, VersionStore } from '@pwb/orchestrator';
import type { ModelProvider } from '@pwb/providers';
import { renderDesign, type RenderedDocument } from '@pwb/renderer';
import type { ProjectRepository } from './db/repository.js';

type Stage = 'identity' | 'prototype' | 'finalization';
type FixtureStatus = 'queued' | 'needs_review' | 'rejected' | 'cancelled' | 'succeeded' | 'failed';

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
  private readonly planner = new RunPlanner();
  private readonly scheduler = new Scheduler();
  private readonly approvals: Approval[] = [];
  private currentVersion!: VersionRecord;
  private rendered!: RenderedDocument;
  private currentStage: Stage | null = null;
  private stageIndex = 0;
  private status: FixtureStatus = 'queued';
  private cancelRequested = false;
  private exportManifest: ExportManifest | undefined;
  private lintErrorCount = 0;
  private initialized = false;
  private started = false;
  private statusBeforeCancel: FixtureStatus = 'queued';
  private runIdentifier = '';

  constructor(private readonly options: { repository: ProjectRepository; exportRoot: string; provider: ModelProvider }) {}

  async initialize(runId: string): Promise<void> {
    this.runIdentifier = runId;
    const ir = createFixtureIR();
    await ignoringDuplicate(this.options.repository.createProject({ id: ir.meta.projectId, name: 'Fixture project' }));
    await ignoringDuplicate(this.options.repository.createRun({ id: runId, projectId: ir.meta.projectId, state: 'queued' }));
    this.currentVersion = this.applier.createRoot(ir);
    await ignoringDuplicate(this.options.repository.saveVersion({ id: this.currentVersion.id, projectId: ir.meta.projectId, hash: this.currentVersion.hash, ir: this.currentVersion.ir }));
    this.rendered = renderDesign(ir);
    this.initialized = true;
    await this.record('run.created', { projectId: ir.meta.projectId, versionId: this.currentVersion.id });
    await this.record('version.created', { versionId: this.currentVersion.id, hash: this.currentVersion.hash });
  }

  async runNext(): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (this.status === 'succeeded') return this.snapshot();
    if (this.cancelRequested) { this.status = 'cancelled'; await this.record('run.cancelled', { stageIndex: this.stageIndex }); return this.snapshot(); }
    const plan = this.planner.plan(this.runId(), this.currentVersion.id, 'Fixture briefing: compile an original identity into a production site.');
    const planned = plan.tasks[this.stageIndex];
    if (!planned) return this.snapshot();
    const task = { ...planned, id: `${this.runId()}-${planned.id}-${this.currentVersion.id}`, baseVersionId: this.currentVersion.id };
    this.currentStage = task.stage;
    await ignoringDuplicate(this.options.repository.saveTask(task, this.runId()));
    await this.record('task.queued', { taskId: task.id, stage: task.stage, baseVersionId: task.baseVersionId });
    if (!this.started) { this.started = true; await this.record('run.started', { stage: task.stage }); }
    await this.record('task.started', { taskId: task.id, stage: task.stage });
    const scheduled = await this.scheduler.run([task], (item, signal) => this.options.provider.propose(item, signal));
    const outcome = scheduled.results[0];
    if (this.cancelRequested || outcome?.state === 'cancelled') return this.cancelStage(task);
    const proposal = outcome?.state === 'succeeded' ? outcome.value?.proposal : undefined;
    if (!proposal) {
      this.status = 'failed';
      const reason = outcome?.error instanceof Error ? outcome.error.message : outcome?.value?.summary ?? 'The stage produced no proposal.';
      await this.record('task.failed', { taskId: task.id, stage: task.stage, reason });
      throw new Error(`Stage ${task.stage} produced no proposal: ${reason}`);
    }
    let next: VersionRecord;
    try {
      renderDesign(this.applier.dryRun(proposal, task.allowedPaths).next);
      next = this.applier.apply(proposal, task.allowedPaths);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The proposal did not validate.';
      await this.record('task.failed', { taskId: task.id, stage: task.stage, reason });
      throw error;
    }
    await ignoringDuplicate(this.options.repository.savePatch(proposal, this.runId()));
    await ignoringDuplicate(this.options.repository.saveVersion({ id: next.id, projectId: this.projectId(), ...(next.parentId ? { parentId: next.parentId } : {}), hash: next.hash, ir: next.ir }));
    this.currentVersion = next;
    this.rendered = renderDesign(next.ir);
    this.lintErrorCount = lintDesign(next.ir).errorCount;
    await this.record('patch.applied', { taskId: task.id, stage: task.stage, baseVersionId: task.baseVersionId, versionId: next.id });
    await this.record('version.created', { versionId: next.id, hash: next.hash });
    await this.record('task.succeeded', { taskId: task.id, stage: task.stage, versionId: next.id });
    if (this.cancelRequested) {
      this.cancelRequested = false;
      this.statusBeforeCancel = 'needs_review';
      this.status = 'cancelled';
      return this.snapshot();
    }
    this.status = 'needs_review';
    return this.snapshot();
  }

  async approve(stage: Stage, approverRole: 'captain' | string, rationale = 'Captain reviewed the typed proposal.'): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (approverRole !== 'captain') throw new Error('Only the captain can approve v1 gates.');
    if (this.status !== 'needs_review' || this.currentStage !== stage) throw new Error(`Stage ${stage} is not awaiting approval.`);
    const approval: Approval = { id: `${this.runId()}-${stage}-approval`, stage, approverRole: 'captain', versionId: this.currentVersion.id, versionHash: this.currentVersion.hash, decision: 'approved', rationale, createdAt: new Date().toISOString() };
    this.approvals.push(approval);
    await ignoringDuplicate(this.options.repository.createApproval({ ...approval, runId: this.runId(), projectId: this.projectId() }));
    await this.record('approval.recorded', { stage, decision: 'approved', versionId: approval.versionId });
    if (stage === 'finalization') {
      this.exportManifest = await exportStatic(this.rendered, this.currentVersion.ir, this.options.exportRoot);
      this.stageIndex += 1;
      this.status = 'succeeded';
      await this.record('run.finished', { status: 'succeeded', digest: this.exportManifest.digest });
    } else { this.stageIndex += 1; this.currentStage = null; this.status = 'queued'; }
    return this.snapshot();
  }

  async reject(stage: Stage, approverRole: 'captain' | string, rationale = 'Captain requested a revision.'): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (approverRole !== 'captain') throw new Error('Only the captain can reject v1 gates.');
    if (this.status !== 'needs_review' || this.currentStage !== stage) throw new Error(`Stage ${stage} is not awaiting review.`);
    const rejection: Approval = { id: `${this.runId()}-${stage}-rejection-${this.approvals.length}`, stage, approverRole: 'captain', versionId: this.currentVersion.id, versionHash: this.currentVersion.hash, decision: 'rejected', rationale, createdAt: new Date().toISOString() };
    this.approvals.push(rejection);
    await ignoringDuplicate(this.options.repository.createApproval({ ...rejection, runId: this.runId(), projectId: this.projectId() }));
    this.status = 'rejected';
    await this.record('approval.recorded', { stage, decision: 'rejected', versionId: rejection.versionId });
    return this.snapshot();
  }

  async runAll(): Promise<FixtureSnapshot> { while (this.stageIndex < 3) { await this.runNext(); if (this.status === 'cancelled') break; const stage = this.currentStage; if (!stage) throw new Error('Run did not produce a gate.'); await this.approve(stage, 'captain'); } return this.snapshot(); }
  async cancel(): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (this.status === 'succeeded' || this.status === 'cancelled') return this.snapshot();
    this.statusBeforeCancel = this.status;
    this.cancelRequested = true;
    this.status = 'cancelled';
    await this.record('run.cancelled', { status: this.statusBeforeCancel, stage: this.currentStage });
    return this.snapshot();
  }

  private async cancelStage(task: { id: string; stage: Stage }): Promise<FixtureSnapshot> {
    this.cancelRequested = false;
    this.status = 'cancelled';
    await this.record('task.cancelled', { taskId: task.id, stage: task.stage });
    return this.snapshot();
  }
  async restart(): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (this.status !== 'cancelled') return this.snapshot();
    this.cancelRequested = false;
    this.status = this.statusBeforeCancel;
    await this.record('run.restarted', { status: this.status, stage: this.currentStage });
    return this.snapshot();
  }
  snapshot(): FixtureSnapshot { this.requireInitialized(); return { runId: this.runId(), projectId: this.projectId(), status: this.status, currentStage: this.currentStage, currentVersion: structuredClone(this.currentVersion), rendered: structuredClone(this.rendered), approvals: structuredClone(this.approvals), ...(this.exportManifest ? { exportManifest: structuredClone(this.exportManifest) } : {}), lintErrorCount: this.lintErrorCount }; }
  private async record(type: string, payload: Record<string, unknown>): Promise<void> { await this.options.repository.appendEvent({ id: randomUUID(), runId: this.runId(), type, payload }); }
  private runId(): string { return this.runIdentifier; }
  private projectId(): string { return this.currentVersion.ir.meta.projectId; }
  private requireInitialized(): void { if (!this.initialized) throw new Error('Fixture run is not initialized.'); }
}
