import { createFixtureIR, type Approval } from '@pwb/domain';
import { exportStatic, type ExportManifest } from '@pwb/export';
import { lintDesign } from '@pwb/linter';
import { Applier, PatchGate, RunPlanner, type VersionRecord, VersionStore } from '@pwb/orchestrator';
import { FakeModelProvider } from '@pwb/providers';
import { renderDesign, type RenderedDocument } from '@pwb/renderer';
import type { ProjectRepository } from './db/repository.js';

type Stage = 'identity' | 'prototype' | 'finalization';
type FixtureStatus = 'queued' | 'needs_review' | 'cancelled' | 'succeeded' | 'failed';

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
  private readonly provider = new FakeModelProvider();
  private readonly planner = new RunPlanner();
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
  private runIdentifier = '';

  constructor(private readonly options: { repository: ProjectRepository; exportRoot: string }) {}

  async initialize(runId: string): Promise<void> {
    this.runIdentifier = runId;
    const ir = createFixtureIR();
    try { await this.options.repository.createProject({ id: ir.meta.projectId, name: 'Fixture project' }); } catch { /* restart-safe */ }
    try { await this.options.repository.createRun({ id: runId, projectId: ir.meta.projectId, state: 'queued' }); } catch { /* restart-safe */ }
    this.currentVersion = this.applier.createRoot(ir);
    try { await this.options.repository.saveVersion({ id: this.currentVersion.id, projectId: ir.meta.projectId, hash: this.currentVersion.hash, ir: this.currentVersion.ir }); } catch { /* idempotent restart of the fixture */ }
    this.rendered = renderDesign(ir);
    this.initialized = true;
  }

  async runNext(): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (this.status === 'succeeded') return this.snapshot();
    if (this.cancelRequested) { this.status = 'cancelled'; return this.snapshot(); }
    const plan = this.planner.plan(this.runId(), this.currentVersion.id, 'Fixture briefing: compile an original identity into a production site.');
    const planned = plan.tasks[this.stageIndex];
    if (!planned) return this.snapshot();
    const task = { ...planned, id: `${this.runId()}-${planned.id}`, baseVersionId: this.currentVersion.id };
    this.currentStage = task.stage;
    try { await this.options.repository.saveTask(task, this.runId()); } catch { /* idempotent restart of the fixture */ }
    const result = await this.provider.propose(task);
    if (this.cancelRequested) { this.status = 'cancelled'; return this.snapshot(); }
    if (!result.proposal) { this.status = 'failed'; throw new Error('Fixture provider returned no proposal.'); }
    const next = this.applier.apply(result.proposal);
    try { await this.options.repository.savePatch(result.proposal, this.runId()); } catch { /* idempotent restart of the fixture */ }
    try { await this.options.repository.saveVersion({ id: next.id, projectId: this.projectId(), ...(next.parentId ? { parentId: next.parentId } : {}), hash: next.hash, ir: next.ir }); } catch { /* idempotent restart of the fixture */ }
    this.currentVersion = next;
    this.rendered = renderDesign(next.ir);
    this.lintErrorCount = lintDesign(next.ir).errorCount;
    this.status = 'needs_review';
    return this.snapshot();
  }

  async approve(stage: Stage, approverRole: 'captain' | string, rationale = 'Captain reviewed the typed proposal.'): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (approverRole !== 'captain') throw new Error('Only the captain can approve v1 gates.');
    if (this.status !== 'needs_review' || this.currentStage !== stage) throw new Error(`Stage ${stage} is not awaiting approval.`);
    const approval: Approval = { id: `${this.runId()}-${stage}-approval`, stage, approverRole: 'captain', versionId: this.currentVersion.id, versionHash: this.currentVersion.hash, decision: 'approved', rationale, createdAt: new Date().toISOString() };
    this.approvals.push(approval);
    try { await this.options.repository.createApproval({ ...approval, runId: this.runId(), projectId: this.projectId() }); } catch { /* idempotent restart of the fixture */ }
    if (stage === 'finalization') {
      this.exportManifest = await exportStatic(this.rendered, this.currentVersion.ir, this.options.exportRoot);
      this.stageIndex += 1;
      this.status = 'succeeded';
    } else { this.stageIndex += 1; this.currentStage = null; this.status = 'queued'; }
    return this.snapshot();
  }

  async reject(stage: Stage, approverRole: 'captain' | string, rationale = 'Captain requested a revision.'): Promise<FixtureSnapshot> {
    this.requireInitialized();
    if (approverRole !== 'captain') throw new Error('Only the captain can reject v1 gates.');
    if (this.status !== 'needs_review' || this.currentStage !== stage) throw new Error(`Stage ${stage} is not awaiting review.`);
    const rejection: Approval = { id: `${this.runId()}-${stage}-rejection-${this.approvals.length}`, stage, approverRole: 'captain', versionId: this.currentVersion.id, versionHash: this.currentVersion.hash, decision: 'rejected', rationale, createdAt: new Date().toISOString() };
    this.approvals.push(rejection);
    try { await this.options.repository.createApproval({ ...rejection, runId: this.runId(), projectId: this.projectId() }); } catch { /* idempotent restart of the fixture */ }
    return this.snapshot();
  }

  async runAll(): Promise<FixtureSnapshot> { while (this.stageIndex < 3) { await this.runNext(); if (this.status === 'cancelled') break; const stage = this.currentStage; if (!stage) throw new Error('Run did not produce a gate.'); await this.approve(stage, 'captain'); } return this.snapshot(); }
  cancel(): void { if (this.status !== 'succeeded') { this.cancelRequested = true; this.status = 'cancelled'; } }
  restart(): void { if (this.status === 'cancelled') { this.cancelRequested = false; this.status = 'queued'; } }
  snapshot(): FixtureSnapshot { this.requireInitialized(); return { runId: this.runId(), projectId: this.projectId(), status: this.status, currentStage: this.currentStage, currentVersion: structuredClone(this.currentVersion), rendered: structuredClone(this.rendered), approvals: structuredClone(this.approvals), ...(this.exportManifest ? { exportManifest: structuredClone(this.exportManifest) } : {}), lintErrorCount: this.lintErrorCount }; }
  private runId(): string { return this.runIdentifier; }
  private projectId(): string { return this.currentVersion.ir.meta.projectId; }
  private requireInitialized(): void { if (!this.initialized) throw new Error('Fixture run is not initialized.'); }
}
