import { randomUUID } from 'node:crypto';
import { type Approval, type DesignIR } from '@pwb/domain';
import { Applier, PatchGate, Scheduler, VersionStore } from '@pwb/orchestrator';
import { renderDesign, type RenderedDocument } from '@pwb/renderer';
import { declaresDarkScheme } from '@pwb/domain';
import { RENDER_VIEWPORTS, readStateConditions } from '@pwb/render-hub';
import {
  ClaudeInformationArchitect, ClaudeSectionComposer, ClaudeCritiqueRunner,
  DerivedEvidenceSource, FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer,
  PrototypeStage, seedFor, type ControlSeed, type CritiqueProvider, type EvidenceSource, type Finding, type PrototypeStageOutcome,
} from '@pwb/stage-prototype';
import type { ProjectRepository } from './db/repository.js';

const BRIEF = 'Fixture briefing: compile an original identity into a production site.';

export type IssueDecision = 'accepted' | 'rejected' | 'deferred';

export interface IssueDecisionRecord {
  findingId: string;
  decision: IssueDecision;
  rationale: string;
  reviewerRole: 'captain';
  parentVersionId: string;
  versionId: string;
  createdAt: string;
}

/** Everything the Gate 2 screen needs to compare A with B and record what the captain decided. */
export interface Gate2Snapshot {
  runId: string;
  seed: ControlSeed;
  stopReason: PrototypeStageOutcome['stopReason'];
  stopDetail: string;
  gate: PrototypeStageOutcome['gate'];
  journey: string;
  before: { versionId: string; label: string };
  after: { versionId: string; label: string };
  repaired: boolean;
  routes: Array<{ route: string; title: string }>;
  viewports: number[];
  states: string[];
  colorSchemes: Array<'light' | 'dark'>;
  qa: Array<{ id: string; tier: number; severity: string; title: string; message: string; nodeIds: string[] }>;
  lint: Array<{ id: string; severity: string; path: string; message: string }>;
  cycles: PrototypeStageOutcome['cycles'];
  reports: PrototypeStageOutcome['reports'];
  issues: Array<Finding & { applied: boolean; refusal?: string }>;
  decisions: IssueDecisionRecord[];
  approval?: Approval;
}

interface PrototypeRunRecord {
  runId: string;
  seed: ControlSeed;
  store: VersionStore;
  outcome: PrototypeStageOutcome;
  rendered: Map<string, RenderedDocument>;
  decisions: IssueDecisionRecord[];
  approval?: Approval;
}

export interface PrototypeRegistryOptions {
  repository: ProjectRepository;
  /** `fake` keeps CI and the fixture deterministic; `claude-code` runs the owner's local binary. */
  modelProvider?: string;
  evidence?: EvidenceSource;
  seed?: () => DesignIR;
}

/**
 * Owns the prototype runs the Gate 2 screen reviews. A run only starts on an explicit captain request,
 * and every decision it records names the reviewer, the revision pair and a reason.
 */
export class PrototypeRunRegistry {
  private readonly runs = new Map<string, PrototypeRunRecord>();

  constructor(private readonly options: PrototypeRegistryOptions) {}

  has(runId: string): boolean { return this.runs.has(runId); }

  async create(runId: string, seed: ControlSeed = 'fixture'): Promise<Gate2Snapshot> {
    if (this.runs.has(runId)) throw new Error(`Run ${runId} already exists.`);
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const base = applier.createRoot((this.options.seed ?? seedFor(seed))());
    const claude = this.options.modelProvider === 'claude-code';
    const critique: CritiqueProvider = claude ? new ClaudeCritiqueRunner() : new FakeCritiqueProvider();
    const stage = new PrototypeStage({
      store, applier,
      scheduler: new Scheduler(),
      architect: claude ? new ClaudeInformationArchitect() : new FakeInformationArchitect(),
      composer: claude ? new ClaudeSectionComposer() : new FakeSectionComposer(),
      critique,
      evidence: this.options.evidence ?? new DerivedEvidenceSource(),
      brief: BRIEF,
      onEvent: (type, payload) => this.options.repository.appendEvent({ id: randomUUID(), runId, type, payload }),
    });
    const outcome = await stage.run({ runId, baseVersionId: base.id });
    const rendered = new Map<string, RenderedDocument>();
    for (const versionId of new Set([outcome.baseVersionId, outcome.architectVersionId, outcome.compositionVersionId, outcome.versionId])) {
      const version = store.get(versionId);
      if (version) rendered.set(versionId, renderDesign(version.ir));
    }
    const record: PrototypeRunRecord = { runId, seed, store, outcome, rendered, decisions: [] };
    this.runs.set(runId, record);
    return this.snapshot(record);
  }

  get(runId: string): Gate2Snapshot | undefined {
    const record = this.runs.get(runId);
    return record ? this.snapshot(record) : undefined;
  }

  /** Serves both A and B of the comparison from the isolated preview origin. */
  preview(versionId: string): RenderedDocument | undefined {
    for (const record of this.runs.values()) { const document = record.rendered.get(versionId); if (document) return document; }
    return undefined;
  }

  async decide(runId: string, input: { findingId: string; decision: IssueDecision; rationale: string }): Promise<Gate2Snapshot> {
    const record = this.require(runId);
    if (!this.issues(record).some((issue) => issue.id === input.findingId)) throw new Error(`Run ${runId} carries no finding ${input.findingId}.`);
    if (input.rationale.trim() === '') throw new Error('A decision must carry a reason.');
    const decision: IssueDecisionRecord = {
      findingId: input.findingId, decision: input.decision, rationale: input.rationale, reviewerRole: 'captain',
      parentVersionId: record.outcome.compositionVersionId, versionId: record.outcome.versionId, createdAt: new Date().toISOString(),
    };
    record.decisions = [...record.decisions.filter((entry) => entry.findingId !== input.findingId), decision];
    await this.options.repository.appendEvent({ id: randomUUID(), runId, type: 'gate2.issue.decided', payload: { ...decision } });
    return this.snapshot(record);
  }

  async settle(runId: string, input: { decision: 'approved' | 'rejected'; rationale: string }): Promise<Gate2Snapshot> {
    const record = this.require(runId);
    if (record.outcome.gate === 'vetoed' && input.decision === 'approved') throw new Error('A vetoed revision cannot be approved; the deterministic gate has to pass first.');
    const version = record.store.get(record.outcome.versionId);
    if (!version) throw new Error(`Run ${runId} has lost its reviewed revision.`);
    const approval: Approval = {
      id: `${runId}-prototype-${record.decisions.length}-${input.decision}`,
      stage: 'prototype', approverRole: 'captain', versionId: version.id, versionHash: version.hash,
      decision: input.decision, rationale: input.rationale, createdAt: new Date().toISOString(),
    };
    record.approval = approval;
    await this.options.repository.appendEvent({ id: randomUUID(), runId, type: 'gate2.decided', payload: { decision: approval.decision, versionId: approval.versionId, rationale: approval.rationale } });
    return this.snapshot(record);
  }

  private require(runId: string): PrototypeRunRecord {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Run ${runId} was not found.`);
    return record;
  }

  private issues(record: PrototypeRunRecord): Array<Finding & { applied: boolean; refusal?: string }> {
    const applied = new Set(record.outcome.cycles.flatMap((cycle) => cycle.appliedFindingIds));
    const refusals = new Map(record.outcome.rejectedRepairs.map((entry) => [entry.findingId, entry.reason]));
    return record.outcome.reports.flatMap((report) => report.projection.findings).map((finding) => ({
      ...finding, applied: applied.has(finding.id), ...(refusals.has(finding.id) ? { refusal: refusals.get(finding.id)! } : {}),
    }));
  }

  private snapshot(record: PrototypeRunRecord): Gate2Snapshot {
    const { outcome } = record;
    const ir = record.store.get(outcome.versionId)!.ir;
    const repaired = outcome.versionId !== outcome.compositionVersionId;
    return {
      runId: record.runId,
      seed: record.seed,
      stopReason: outcome.stopReason,
      stopDetail: outcome.stopDetail,
      gate: outcome.gate,
      journey: outcome.manifest.journey,
      before: { versionId: outcome.compositionVersionId, label: 'A · composição' },
      after: { versionId: outcome.versionId, label: repaired ? 'B · após o reparo' : 'B · sem reparo aplicado' },
      repaired,
      routes: ir.pages.routes.map((page) => ({ route: page.route, title: page.title })),
      viewports: [...RENDER_VIEWPORTS],
      states: readStateConditions(ir).map((condition) => condition.state),
      colorSchemes: declaresDarkScheme(ir.identity) ? ['light', 'dark'] : ['light'],
      qa: outcome.qa.checks.map((check) => ({ id: check.id, tier: check.tier, severity: check.severity, title: check.title, message: check.message, nodeIds: check.nodeIds })),
      lint: outcome.lint.findings.map((finding) => ({ id: finding.id, severity: finding.severity, path: finding.path, message: finding.message })),
      cycles: outcome.cycles,
      reports: outcome.reports,
      issues: this.issues(record),
      decisions: record.decisions,
      ...(record.approval ? { approval: record.approval } : {}),
    };
  }
}
