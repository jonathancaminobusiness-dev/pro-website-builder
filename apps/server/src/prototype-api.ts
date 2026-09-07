import { randomUUID } from 'node:crypto';
import { createFixtureIR, type Approval, type DesignIR } from '@pwb/domain';
import { Applier, PatchGate, Scheduler, VersionStore } from '@pwb/orchestrator';
import { renderDesign, type RenderedDocument } from '@pwb/renderer';
import { declaresDarkScheme } from '@pwb/domain';
import { RENDER_VIEWPORTS, readStateConditions } from '@pwb/render-hub';
import {
  ClaudeInformationArchitect, ClaudeSectionComposer, ClaudeCritiqueRunner,
  FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer,
  PrototypeStage, type CritiqueProvider, type EvidenceSource, type Finding, type PrototypeStageOutcome,
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

export type PrototypeRunStatus = 'running' | 'settled' | 'failed';

/** Where a run is right now. A start request returns this immediately; the list endpoint returns only this. */
export interface PrototypeRunProgress {
  runId: string;
  status: PrototypeRunStatus;
  /** The last stage event, as the machine name the event log stores. */
  step: string;
  detail: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

/** Everything the Gate 2 screen needs to compare A with B and record what the captain decided. */
export interface Gate2Result {
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

/** The run as the Gate 2 screen polls it: progress always, the review once the stage settled. */
export interface Gate2Snapshot extends PrototypeRunProgress {
  result?: Gate2Result;
}

interface PrototypeRunRecord {
  runId: string;
  store: VersionStore;
  progress: PrototypeRunProgress;
  outcome?: PrototypeStageOutcome;
  decisions: IssueDecisionRecord[];
  approval?: Approval;
}

/** One sentence per stage event, so a run that takes minutes says what it is doing. */
function describeStep(type: string, payload: Record<string, unknown>): string {
  const list = (value: unknown): string => Array.isArray(value) ? value.join(', ') : '';
  if (type === 'prototype.manifest.applied') return `Arquitetura de informação pronta: ${list(payload.routes)}.`;
  if (type === 'prototype.sections.applied') return `Seções compostas em paralelo: ${list(payload.sections)}.`;
  if (type === 'prototype.qa.gate') return `QA determinístico medido no navegador: ${Array.isArray(payload.vetoes) ? payload.vetoes.length : 0} veto(s).`;
  if (type === 'prototype.cycle.decided') return `Ciclo ${String(payload.cycle)}: ${String(payload.reason)}.`;
  if (type === 'prototype.refine.applied') return `Ciclo ${String(payload.cycle)}: reparo causal aplicado.`;
  if (type === 'prototype.refine.refused') return `Ciclo ${String(payload.cycle)}: reparo recusado.`;
  if (type === 'prototype.critic.unavailable') return `Um crítico não entregou relatório: ${String(payload.reason)}.`;
  if (type === 'prototype.stage.settled') return `Etapa concluída: ${String(payload.stopReason)}.`;
  return type;
}

export interface PrototypeRegistryOptions {
  repository: ProjectRepository;
  /** `fake` keeps CI and the fixture deterministic; `claude-code` runs the owner's local binary. */
  modelProvider?: string;
  /** Where the deterministic gate's evidence is measured; the server always hands it the RenderHub. */
  evidence: EvidenceSource;
  /** The revision a run starts from; tests inject a document with a known defect through it. */
  seed?: () => DesignIR;
}

/**
 * Owns the prototype runs the Gate 2 screen reviews. A run only starts on an explicit captain request,
 * and every decision it records names the reviewer, the revision pair and a reason.
 */
export class PrototypeRunRegistry {
  private readonly runs = new Map<string, PrototypeRunRecord>();
  private readonly rendered = new Map<string, RenderedDocument>();

  constructor(private readonly options: PrototypeRegistryOptions) {}

  has(runId: string): boolean { return this.runs.has(runId); }

  /**
   * Starts a run and answers at once with its id and progress. Measuring the capture matrix takes
   * minutes, so the stage runs on its own and the screen polls it; a reload never loses the run.
   */
  async create(runId: string): Promise<Gate2Snapshot> {
    if (this.runs.has(runId)) throw new Error(`Run ${runId} already exists.`);
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const base = applier.createRoot((this.options.seed ?? createFixtureIR)());
    const startedAt = new Date().toISOString();
    const record: PrototypeRunRecord = {
      runId, store, decisions: [],
      progress: { runId, status: 'running', step: 'prototype.run.started', detail: 'Execução aceita; compondo o protótipo.', startedAt, updatedAt: startedAt },
    };
    this.runs.set(runId, record);

    const claude = this.options.modelProvider === 'claude-code';
    const critique: CritiqueProvider = claude ? new ClaudeCritiqueRunner() : new FakeCritiqueProvider();
    const stage = new PrototypeStage({
      store, applier,
      scheduler: new Scheduler(),
      architect: claude ? new ClaudeInformationArchitect() : new FakeInformationArchitect(),
      composer: claude ? new ClaudeSectionComposer() : new FakeSectionComposer(),
      critique,
      evidence: this.options.evidence,
      brief: BRIEF,
      onEvent: (type, payload) => {
        record.progress = { ...record.progress, step: type, detail: describeStep(type, payload), updatedAt: new Date().toISOString() };
        return this.options.repository.appendEvent({ id: randomUUID(), runId, type, payload });
      },
    });
    await this.options.repository.appendEvent({ id: randomUUID(), runId, type: 'prototype.run.started', payload: { runId, baseVersionId: base.id } });
    void this.execute(record, stage, base.id);
    return this.snapshot(record);
  }

  get(runId: string): Gate2Snapshot | undefined {
    const record = this.runs.get(runId);
    return record ? this.snapshot(record) : undefined;
  }

  /** Every run this server holds, newest first, so a run whose tab was closed is still reachable. */
  list(): PrototypeRunProgress[] {
    return [...this.runs.values()].map((record) => record.progress).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  /**
   * Serves both A and B of the comparison from the isolated preview origin, and every intermediate
   * revision the deterministic gate measures while the stage is still running.
   */
  preview(versionId: string): RenderedDocument | undefined {
    const cached = this.rendered.get(versionId);
    if (cached) return cached;
    for (const record of this.runs.values()) {
      const version = record.store.get(versionId);
      if (!version) continue;
      const document = renderDesign(version.ir);
      this.rendered.set(versionId, document);
      return document;
    }
    return undefined;
  }

  private async execute(record: PrototypeRunRecord, stage: PrototypeStage, baseVersionId: string): Promise<void> {
    try {
      record.outcome = await stage.run({ runId: record.runId, baseVersionId });
      record.progress = { ...record.progress, status: 'settled', detail: record.outcome.stopDetail, updatedAt: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'A etapa de protótipo falhou.';
      record.progress = { ...record.progress, status: 'failed', step: 'prototype.run.failed', detail: message, error: message, updatedAt: new Date().toISOString() };
      await this.options.repository.appendEvent({ id: randomUUID(), runId: record.runId, type: 'prototype.run.failed', payload: { error: message } }).catch(() => undefined);
    }
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

  private require(runId: string): PrototypeRunRecord & { outcome: PrototypeStageOutcome } {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Run ${runId} was not found.`);
    if (!record.outcome) throw new Error(`Run ${runId} is still ${record.progress.status === 'failed' ? 'unfinished' : 'running'}; there is nothing to decide yet.`);
    return record as PrototypeRunRecord & { outcome: PrototypeStageOutcome };
  }

  private issues(record: PrototypeRunRecord & { outcome: PrototypeStageOutcome }): Array<Finding & { applied: boolean; refusal?: string }> {
    const applied = new Set(record.outcome.cycles.flatMap((cycle) => cycle.appliedFindingIds));
    const refusals = new Map(record.outcome.rejectedRepairs.map((entry) => [entry.findingId, entry.reason]));
    return record.outcome.reports.flatMap((report) => report.projection.findings).map((finding) => ({
      ...finding, applied: applied.has(finding.id), ...(refusals.has(finding.id) ? { refusal: refusals.get(finding.id)! } : {}),
    }));
  }

  private snapshot(record: PrototypeRunRecord): Gate2Snapshot {
    if (!record.outcome) return { ...record.progress };
    return { ...record.progress, result: this.result(record as PrototypeRunRecord & { outcome: PrototypeStageOutcome }) };
  }

  private result(record: PrototypeRunRecord & { outcome: PrototypeStageOutcome }): Gate2Result {
    const { outcome } = record;
    const ir = record.store.get(outcome.versionId)!.ir;
    const repaired = outcome.versionId !== outcome.compositionVersionId;
    return {
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
