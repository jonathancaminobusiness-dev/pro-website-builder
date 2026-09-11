import { randomUUID } from 'node:crypto';
import { agentTaskSchema, createFixtureIR, hashJson, stageRoles, type Approval, type DesignIR } from '@pwb/domain';
import { Applier, DEFAULT_MAX_ACTIVE_CLAUDE, PatchGate, Scheduler, VersionStore, type VersionRecord } from '@pwb/orchestrator';
import { renderDesign, type RenderedDocument } from '@pwb/renderer';
import { declaresDarkScheme } from '@pwb/domain';
import { readStateConditions } from '@pwb/render-hub';
import {
  ClaudeInformationArchitect, ClaudeSectionComposer, ClaudeCritiqueRunner, criticRegistry, CRITIC_DEADLINE_MS,
  DEFAULT_LOOP_BUDGET, FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer,
  CodexSession, PrototypeStage, type CritiqueProvider, type EvidenceSource, type Finding, type PrototypeStageOutcome,
} from '@pwb/stage-prototype';
import type { ProjectRepository } from './db/repository.js';
import { modelAlias, modelProviderName, type ModelProviderName } from './provider.js';

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

export type PrototypeRunStatus = 'queued' | 'running' | 'settled' | 'failed' | 'interrupted';

/**
 * Headroom the scheduler deadline keeps over the loop's own budget. The loop reads its budget only at
 * a cycle boundary, so the abort has to outlast everything one more cycle can spend after the last
 * check: every wave of critics the model lane admits, plus the capture matrix that precedes them.
 * The matrix carries no deadline of its own, so this is generous headroom rather than a bound.
 */
const CRITIC_WAVES = Math.ceil(criticRegistry.length / DEFAULT_MAX_ACTIVE_CLAUDE);
const CAPTURE_MATRIX_HEADROOM_MS = 10 * 60_000;
const STAGE_DEADLINE_SLACK_MS = CRITIC_WAVES * CRITIC_DEADLINE_MS + CAPTURE_MATRIX_HEADROOM_MS;

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
  /** The widths this run measured; the screen compares A with B only where the gate looked. */
  viewports: number[];
  states: string[];
  colorSchemes: Array<'light' | 'dark'>;
  qa: Array<{ id: string; tier: number; severity: string; title: string; message: string; nodeIds: string[] }>;
  lint: Array<{ id: string; severity: string; path: string; message: string }>;
  /**
   * The sections no composer filled. Their windows still hold the architect's
   * placeholders, so the review is partial and says which parts of it are a gap
   * rather than a decision.
   */
  failedSections: PrototypeStageOutcome['failedSections'];
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

/** What a run needs from disk to be reviewed again after a restart: its outcome and the two revisions it compares. */
interface PersistedRun {
  outcome?: PrototypeStageOutcome;
  decisions: IssueDecisionRecord[];
  approval?: Approval;
  versions: VersionRecord[];
}

/** One sentence per stage event, so a run that takes minutes says what it is doing. */
function describeStep(type: string, payload: Record<string, unknown>): string {
  const list = (value: unknown): string => Array.isArray(value) ? value.join(', ') : '';
  if (type === 'prototype.manifest.applied') return `Arquitetura de informação pronta: ${list(payload.routes)}.`;
  if (type === 'prototype.sections.applied') {
    const failed = Array.isArray(payload.failedSections) ? payload.failedSections : [];
    return `Seções compostas em paralelo: ${list(payload.sections)}.${failed.length > 0 ? ` Sem composição: ${failed.join(', ')}.` : ''}`;
  }
  if (type === 'prototype.section.unavailable') return `A seção ${String(payload.sectionId)} não foi composta: ${String(payload.reason)}.`;
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
  /**
   * `fake` keeps CI and the fixture deterministic; the named local providers run
   * their CLI. It is a `ModelProviderName` and the constructor resolves it
   * through `modelProviderName`, so `provider.ts` stays the one place a provider
   * name is recognised: `'Codex'` or a trailing space is a startup error, never
   * a deterministic run nobody asked for.
   */
  modelProvider?: ModelProviderName;
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
  /** One browser matrix at a time: the next run waits on the one before it. */
  private lane: Promise<void> = Promise.resolve();
  private readonly scheduler = new Scheduler();

  private readonly modelProvider: ModelProviderName;

  constructor(private readonly options: PrototypeRegistryOptions) {
    this.modelProvider = modelProviderName(options.modelProvider);
  }

  has(runId: string): boolean { return this.runs.has(runId); }

  /**
   * Accepts a run and answers at once with its id and progress. Measuring the capture matrix takes
   * minutes, so the stage runs behind the scheduler and the screen polls it; a reload never loses it,
   * and neither does a restart.
   */
  async create(runId: string): Promise<Gate2Snapshot> {
    if (this.runs.has(runId)) throw new Error(`Run ${runId} already exists.`);
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const base = applier.createRoot((this.options.seed ?? createFixtureIR)());
    const startedAt = new Date().toISOString();
    const record: PrototypeRunRecord = {
      runId, store, decisions: [],
      progress: { runId, status: 'queued', step: 'prototype.run.queued', detail: 'Na fila: o servidor mede uma revisão por vez.', startedAt, updatedAt: startedAt },
    };
    this.runs.set(runId, record);
    await this.options.repository.appendEvent({ id: randomUUID(), runId, type: 'prototype.run.queued', payload: { runId, baseVersionId: base.id } });
    await this.persist(record);
    // The lane has to survive whatever this run does to it. `execute` handles its own failures, but
    // anything it cannot - a repository that will not write, a bug above the scheduler - would
    // otherwise reject the chain itself: an unhandled rejection, and every run queued behind this one
    // waiting forever on a promise that already settled. So the run is failed here and the lane is
    // handed on resolved.
    this.lane = this.lane.then(() => this.execute(record, applier, base.id)).catch((error: unknown) => this.abandon(record, error));
    return this.snapshot(record);
  }

  /**
   * Reads back the runs a previous process left behind. A run that was still measuring when the server
   * stopped is marked interrupted rather than dropped, so the captain sees what happened to it.
   */
  async restore(): Promise<void> {
    for (const row of this.options.repository.listPrototypeRuns()) {
      if (this.runs.has(row.id)) continue;
      const persisted = row.payload as unknown as PersistedRun;
      const store = new VersionStore();
      for (const version of persisted.versions ?? []) store.save(version);
      const unfinished = row.status === 'queued' || row.status === 'running';
      const record: PrototypeRunRecord = {
        runId: row.id, store, decisions: persisted.decisions ?? [],
        ...(persisted.outcome ? { outcome: persisted.outcome } : {}),
        ...(persisted.approval ? { approval: persisted.approval } : {}),
        progress: {
          runId: row.id,
          status: unfinished ? 'interrupted' : row.status as PrototypeRunStatus,
          step: unfinished ? 'prototype.run.interrupted' : row.step,
          detail: unfinished ? 'O servidor parou no meio da medição; peça outra execução.' : row.detail,
          startedAt: row.startedAt,
          updatedAt: unfinished ? new Date().toISOString() : row.updatedAt,
          ...(row.error === undefined ? {} : { error: row.error }),
          ...(unfinished ? { error: 'A execução foi interrompida quando o servidor parou.' } : {}),
        },
      };
      this.runs.set(row.id, record);
      if (unfinished) await this.persist(record);
    }
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
      const document = renderDesign(version.ir, { routePrefix: `/preview/${versionId}` });
      this.rendered.set(versionId, document);
      return document;
    }
    return undefined;
  }

  /**
   * Runs the stage as one scheduler task on the raster lane, which is where its deadline and abort
   * signal come from. What serializes the browser matrix is the `lane` promise chain in `create`:
   * a `Scheduler` counts its lane semaphore per `run()` call, so two calls never see each other.
   */
  private async execute(record: PrototypeRunRecord, applier: Applier, baseVersionId: string): Promise<void> {
    const { runId } = record;
    const identity = record.store.get(baseVersionId)!.ir.identity;
    const claude = this.modelProvider === 'claude-code';
    const codex = this.modelProvider === 'codex';
    const model = claude || codex;
    const stage = new PrototypeStage({
      store: record.store, applier,
      scheduler: new Scheduler(),
      architect: model ? new ClaudeInformationArchitect(codex ? { session: new CodexSession() } : {}) : new FakeInformationArchitect(),
      composer: model ? new ClaudeSectionComposer(codex ? { session: new CodexSession() } : {}) : new FakeSectionComposer(),
      critique: model ? new ClaudeCritiqueRunner(codex ? { session: new CodexSession() } : {}) : new FakeCritiqueProvider(),
      evidence: this.options.evidence,
      brief: BRIEF,
      modelAlias: modelAlias(this.modelProvider),
      onEvent: async (type, payload) => {
        // An aborted stage keeps unwinding for a few seconds; whatever it still reports must not
        // overwrite the terminal record the scheduler already settled.
        if (record.progress.status !== 'queued' && record.progress.status !== 'running') return;
        record.progress = { ...record.progress, step: type, detail: describeStep(type, payload), updatedAt: new Date().toISOString() };
        await this.options.repository.appendEvent({ id: randomUUID(), runId, type, payload });
        await this.persist(record);
      },
    });
    const task = agentTaskSchema.parse({
      id: `${runId}-prototype`, attempt: 1, stage: 'prototype', role: stageRoles.prototype, state: 'queued', lane: 'raster',
      baseVersionId, inputDigest: hashJson([BRIEF, baseVersionId]), promptVersion: 'gate2-run-v1',
      modelAlias: modelAlias(this.modelProvider), deadlineMs: DEFAULT_LOOP_BUDGET.deadlineMs + STAGE_DEADLINE_SLACK_MS,
      allowedPaths: [], brief: BRIEF, documentSlice: { '/identity': identity },
    });

    record.progress = { ...record.progress, status: 'running', step: 'prototype.run.started', detail: 'Medindo o protótipo no navegador.', updatedAt: new Date().toISOString() };
    await this.options.repository.appendEvent({ id: randomUUID(), runId, type: 'prototype.run.started', payload: { runId, baseVersionId } }).catch(() => undefined);
    await this.persist(record).catch(() => undefined);

    const result = await this.scheduler.run([task], (queued, signal) => stage.run({ runId, baseVersionId, signal }));
    const entry = result.results[0];
    if (entry?.state === 'succeeded' && entry.value) {
      record.outcome = entry.value;
      record.progress = { ...record.progress, status: 'settled', detail: entry.value.stopDetail, updatedAt: new Date().toISOString() };
    } else {
      const message = entry?.error instanceof Error ? entry.error.message : 'A etapa de protótipo não produziu uma revisão.';
      record.progress = { ...record.progress, status: 'failed', step: 'prototype.run.failed', detail: message, error: message, updatedAt: new Date().toISOString() };
      await this.options.repository.appendEvent({ id: randomUUID(), runId, type: 'prototype.run.failed', payload: { error: message } }).catch(() => undefined);
    }
    await this.persist(record).catch(() => undefined);
  }

  /**
   * The last resort for a run whose execution threw where nothing else could catch it. It records the
   * failure on the run that caused it and swallows nothing else, so the lane keeps serving.
   */
  private async abandon(record: PrototypeRunRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'A execução da etapa de protótipo falhou antes de produzir uma revisão.';
    record.progress = { ...record.progress, status: 'failed', step: 'prototype.run.failed', detail: message, error: message, updatedAt: new Date().toISOString() };
    await this.options.repository.appendEvent({ id: randomUUID(), runId: record.runId, type: 'prototype.run.failed', payload: { error: message } }).catch(() => undefined);
    await this.persist(record).catch(() => undefined);
  }

  /** The whole run, so the next process can serve this review without measuring anything again. */
  private async persist(record: PrototypeRunRecord): Promise<void> {
    const reviewed = record.outcome ? [record.outcome.compositionVersionId, record.outcome.versionId] : [];
    const versions = [...new Set(reviewed)].flatMap((versionId) => record.store.get(versionId) ?? []);
    const payload: PersistedRun = {
      ...(record.outcome ? { outcome: record.outcome } : {}),
      decisions: record.decisions,
      ...(record.approval ? { approval: record.approval } : {}),
      versions,
    };
    await this.options.repository.savePrototypeRun({
      id: record.runId,
      status: record.progress.status,
      step: record.progress.step,
      detail: record.progress.detail,
      ...(record.progress.error === undefined ? {} : { error: record.progress.error }),
      startedAt: record.progress.startedAt,
      updatedAt: record.progress.updatedAt,
      payload: payload as unknown as Record<string, unknown>,
    });
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
    await this.persist(record);
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
    await this.persist(record);
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
      viewports: outcome.measuredViewports,
      states: readStateConditions(ir).map((condition) => condition.state),
      colorSchemes: declaresDarkScheme(ir.identity) ? ['light', 'dark'] : ['light'],
      qa: outcome.qa.checks.map((check) => ({ id: check.id, tier: check.tier, severity: check.severity, title: check.title, message: check.message, nodeIds: check.nodeIds })),
      lint: outcome.lint.findings.map((finding) => ({ id: finding.id, severity: finding.severity, path: finding.path, message: finding.message })),
      failedSections: outcome.failedSections ?? [],
      cycles: outcome.cycles,
      reports: outcome.reports,
      issues: this.issues(record),
      decisions: record.decisions,
      ...(record.approval ? { approval: record.approval } : {}),
    };
  }
}
