import { randomUUID } from 'node:crypto';
import { agentTaskSchema, designIRSchema, hashJson, stageRoles, type Approval, type DesignIR } from '@pwb/domain';
import { Applier, DEFAULT_MAX_ACTIVE_CLAUDE, PatchGate, Scheduler, VersionStore, type VersionRecord } from '@pwb/orchestrator';
import { renderDesign, type RenderedDocument } from '@pwb/renderer';
import { identityHash } from '@pwb/stage-identity';
import { declaresDarkScheme } from '@pwb/domain';
import { readStateConditions } from '@pwb/render-hub';
import {
  ClaudeInformationArchitect, ClaudeSectionComposer, ClaudeCritiqueRunner, criticRegistry, CRITIC_DEADLINE_MS,
  DEFAULT_LOOP_BUDGET, FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer,
  CodexSession, PrototypeStage, type CritiqueProvider, type EvidenceSource, type Finding, type PrototypeStageOutcome,
} from '@pwb/stage-prototype';
import { ignoringDuplicate } from './db/duplicates.js';
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

/**
 * What Gate 1 approved, as the prototype stage needs it: the execution that
 * decided, the version it decided on, and the identity hash that decision
 * recorded. The prototype run measures its own identity hash from the document
 * it was seeded with, so the two agreeing is a fact rather than a claim.
 */
export interface IdentitySeed {
  identityRunId: string;
  projectId: string;
  versionId: string;
  identityHash: string;
  approvedAt: string;
  /** True once the identity moved after the gate closed; such a version is not handed on. */
  stale: boolean;
  ir: DesignIR;
  /**
   * The imagery generated for the approved direction. It travels beside the
   * document because the identity stage may not write `/assets`, and the
   * prototype composes over the ledger this places it in.
   */
  assets: DesignIR['assets']['items'];
}

/** The link from a prototype run back to the Gate 1 execution it starts from. */
export interface PrototypeChain {
  identityRunId: string;
  identityVersionId: string;
  identityHash: string;
  projectId: string;
  /**
   * The imagery Gate 1 approved, as it stood when this run was seeded. Gate 2
   * never waits on the raster lane: what the lane delivered is in the document
   * with its bytes, and what it did not is in the document as the placeholder it
   * is, so the review shows what this revision actually has.
   */
  seededImagery?: Array<{ id: string; status: DesignIR['assets']['items'][number]['status']; note?: string }>;
}

/** Which approved identity a run is asked to start from; one of the two names it. */
export interface PrototypeRunRequest {
  identityRunId?: string;
  versionId?: string;
}

/** Gate 2 was asked to run on an identity Gate 1 has not approved, or no longer approves. */
export class Gate1NotApprovedError extends Error {}

/**
 * The gate of a review that is already decided. A decision writes a permanent
 * `approvals` row the release gate reads, so a screen still holding the
 * pre-decision snapshot must not overwrite it: the review is re-measured in a
 * new run instead.
 */
export class Gate2AlreadyDecidedError extends Error {}

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
  /** The Gate 1 execution this run was seeded from; every run has one. */
  chain: PrototypeChain;
  /** The last stage event, as the machine name the event log stores. */
  step: string;
  detail: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

/** Everything the Gate 2 screen needs to compare A with B and record what the captain decided. */
export interface Gate2Result {
  /**
   * The identity hash measured from the reviewed document, never copied from the
   * request. The prototype stage may not write `/identity`, so this is what
   * proves the revision under review is still the identity Gate 1 approved.
   */
  identityHash: string;
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
  chain: PrototypeChain;
  progress: PrototypeRunProgress;
  outcome?: PrototypeStageOutcome;
  decisions: IssueDecisionRecord[];
  approval?: Approval;
}

/** What a run needs from disk to be reviewed again after a restart: its outcome and the two revisions it compares. */
interface PersistedRun {
  chain?: PrototypeChain;
  outcome?: PrototypeStageOutcome;
  decisions: IssueDecisionRecord[];
  approval?: Approval;
  versions: VersionRecord[];
}

/**
 * The approved document with Gate 1's own imagery on it: an asset the gate
 * generated replaces the placeholder of the same id and any other is added, so
 * the prototype composes over what the captain approved rather than over the
 * fixture's stand-ins.
 */
function withApprovedImagery(seed: IdentitySeed): DesignIR {
  if (seed.assets.length === 0) return seed.ir;
  const items = new Map(seed.ir.assets.items.map((asset) => [asset.id, asset]));
  for (const asset of seed.assets) items.set(asset.id, asset);
  return { ...seed.ir, assets: { items: [...items.values()] } };
}

/** Every approved image with the status it carries, so the review states what it has. */
function seededImagery(seed: IdentitySeed): NonNullable<PrototypeChain['seededImagery']> {
  return seed.assets.map((asset) => ({
    id: asset.id,
    status: asset.status,
    ...(asset.status === 'ready' || asset.provenance.termsNote === undefined ? {} : { note: asset.provenance.termsNote }),
  }));
}

/**
 * The document this run is measured over, as a version of its own. It is the
 * approved identity when Gate 1 generated no imagery, and otherwise a child of
 * it whose id derives from its own bytes: the same id may not name two
 * documents, and the ledger row has to be what Gate 2 actually measured.
 */
function seededRoot(store: VersionStore, applier: Applier, seed: IdentitySeed): VersionRecord {
  const document = withApprovedImagery(seed);
  if (document === seed.ir) return applier.createRoot(seed.ir);
  const parsed = designIRSchema.parse(document);
  const versionId = `v-${hashJson(parsed).slice(0, 12)}`;
  const existing = store.get(versionId);
  if (existing) return existing;
  const ir = { ...parsed, meta: { ...parsed.meta, versionId } };
  const root: VersionRecord = { id: versionId, hash: hashJson(ir), parentId: seed.versionId, ir };
  store.save(root);
  return root;
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
  /** `fake` keeps CI and the fixture deterministic; the named local providers run their CLI. */
  modelProvider?: string;
  /** Where the deterministic gate's evidence is measured; the server always hands it the RenderHub. */
  evidence: EvidenceSource;
  /**
   * Reads back what Gate 1 approved, and it is the only way a run gets a
   * document: the prototype stage exists to work on the approved identity, so a
   * request the captain did not approve is refused rather than measured. Tests
   * inject a document with a known defect as the identity a Gate 1 approved.
   */
  identity: (request: PrototypeRunRequest) => Promise<IdentitySeed | undefined>;
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

  constructor(private readonly options: PrototypeRegistryOptions) {}

  has(runId: string): boolean { return this.runs.has(runId); }

  /**
   * Accepts a run and answers at once with its id and progress. Measuring the capture matrix takes
   * minutes, so the stage runs behind the scheduler and the screen polls it; a reload never loses it,
   * and neither does a restart.
   */
  async create(runId: string, request: PrototypeRunRequest = {}): Promise<Gate2Snapshot> {
    if (this.runs.has(runId)) throw new Error(`Run ${runId} already exists.`);
    const seed = await this.resolveSeed(request);
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    // Every revision this run produces descends from what Gate 1 approved: from
    // that version itself, or from the child that carries the imagery the
    // identity stage could not write into the document.
    const base = seededRoot(store, applier, seed);
    const startedAt = new Date().toISOString();
    const imagery = seededImagery(seed);
    const chain: PrototypeChain = { identityRunId: seed.identityRunId, identityVersionId: seed.versionId, identityHash: seed.identityHash, projectId: seed.projectId, ...(imagery.length > 0 ? { seededImagery: imagery } : {}) };
    const record: PrototypeRunRecord = {
      runId, store, decisions: [], chain,
      progress: { runId, chain, status: 'queued', step: 'prototype.run.queued', detail: 'Na fila: o servidor mede uma revisão por vez.', startedAt, updatedAt: startedAt },
    };
    this.runs.set(runId, record);
    await this.options.repository.appendEvent({ id: randomUUID(), runId, type: 'prototype.run.queued', payload: { runId, baseVersionId: base.id, identityRunId: chain.identityRunId, identityVersionId: chain.identityVersionId, identityHash: chain.identityHash } });
    await this.persist(record);
    this.lane = this.lane.then(() => this.execute(record, applier, base.id));
    return this.snapshot(record);
  }

  /**
   * What Gate 1 approved, or a refusal. A run measures only an approved
   * identity: a request that names none, names one the captain never decided, or
   * names one whose tokens moved after the decision is refused rather than
   * silently answered with a document of the server's choosing.
   */
  private async resolveSeed(request: PrototypeRunRequest): Promise<IdentitySeed> {
    const read = this.options.identity;
    const named = (request.identityRunId ?? '').trim() || (request.versionId ?? '').trim();
    if (!named) throw new Gate1NotApprovedError('A etapa de protótipo começa da identidade aprovada: informe a execução do Gate 1 ou a versão que ela aprovou.');
    const seed = await read({
      ...(request.identityRunId?.trim() ? { identityRunId: request.identityRunId.trim() } : {}),
      ...(request.versionId?.trim() ? { versionId: request.versionId.trim() } : {}),
    });
    if (!seed) throw new Gate1NotApprovedError('O Gate 1 desta execução ainda não foi aprovado pelo capitão; não há identidade para o protótipo partir.');
    if (seed.stale) throw new Gate1NotApprovedError('A identidade mudou depois do Gate 1: aprove-a de novo antes de medir o protótipo.');
    const asked = request.versionId?.trim();
    if (asked && asked !== seed.versionId) throw new Gate1NotApprovedError(`O Gate 1 desta execução aprovou a versão ${seed.versionId}, e não ${asked}.`);
    return seed;
  }

  /**
   * Reads back the runs a previous process left behind. A run that was still measuring when the server
   * stopped is marked interrupted rather than dropped, so the captain sees what happened to it.
   */
  async restore(): Promise<void> {
    for (const row of this.options.repository.listPrototypeRuns()) {
      if (this.runs.has(row.id)) continue;
      const persisted = row.payload as unknown as PersistedRun;
      // A row written before Gate 2 was seeded from Gate 1 names no identity, so
      // there is no chain to decide it into; it is not served as a review.
      if (!persisted.chain) continue;
      const store = new VersionStore();
      for (const version of persisted.versions ?? []) store.save(version);
      const unfinished = row.status === 'queued' || row.status === 'running';
      const record: PrototypeRunRecord = {
        runId: row.id, store, decisions: persisted.decisions ?? [], chain: persisted.chain,
        ...(persisted.outcome ? { outcome: persisted.outcome } : {}),
        ...(persisted.approval ? { approval: persisted.approval } : {}),
        progress: {
          runId: row.id,
          chain: persisted.chain,
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
    const claude = this.options.modelProvider === 'claude-code';
    const codex = this.options.modelProvider === 'codex';
    const model = claude || codex;
    const stage = new PrototypeStage({
      store: record.store, applier,
      scheduler: new Scheduler(),
      architect: model ? new ClaudeInformationArchitect(codex ? { session: new CodexSession() } : {}) : new FakeInformationArchitect(),
      composer: model ? new ClaudeSectionComposer(codex ? { session: new CodexSession() } : {}) : new FakeSectionComposer(),
      critique: model ? new ClaudeCritiqueRunner(codex ? { session: new CodexSession() } : {}) : new FakeCritiqueProvider(),
      evidence: this.options.evidence,
      brief: BRIEF,
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
      modelAlias: claude ? 'claude-local' : codex ? 'codex-gpt-5.6-sol' : 'fake', deadlineMs: DEFAULT_LOOP_BUDGET.deadlineMs + STAGE_DEADLINE_SLACK_MS,
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

  /** The whole run, so the next process can serve this review without measuring anything again. */
  private async persist(record: PrototypeRunRecord): Promise<void> {
    // The whole lineage, not just the pair under review: a run restored after a
    // restart still has to be able to write the chain Gate 3 walks.
    const reviewed = record.outcome ? [...this.lineageOf(record, record.outcome.versionId), ...this.lineageOf(record, record.outcome.compositionVersionId)] : [];
    const seen = new Set<string>();
    const versions = reviewed.filter((version) => !seen.has(version.id) && seen.add(version.id));
    const payload: PersistedRun = {
      chain: record.chain,
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

  /** A version and every ancestor this run still holds, parent first. */
  private lineageOf(record: PrototypeRunRecord, versionId: string): VersionRecord[] {
    const lineage: VersionRecord[] = [];
    for (let current = record.store.get(versionId); current; current = current.parentId ? record.store.get(current.parentId) : undefined) lineage.unshift(current);
    return lineage;
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
    if (record.approval) throw new Gate2AlreadyDecidedError(`O Gate 2 desta revisão já foi ${record.approval.decision === 'approved' ? 'aprovado' : 'devolvido'} em ${record.approval.versionId}; recarregue a tela e meça outra revisão para decidir de novo.`);
    if (record.outcome.gate === 'vetoed' && input.decision === 'approved') throw new Error('A vetoed revision cannot be approved; the deterministic gate has to pass first.');
    const version = record.store.get(record.outcome.versionId);
    if (!version) throw new Error(`Run ${runId} has lost its reviewed revision.`);
    const approval: Approval = {
      id: `${runId}-prototype-${record.decisions.length}-${input.decision}`,
      stage: 'prototype', approverRole: 'captain', versionId: version.id, versionHash: version.hash,
      decision: input.decision, rationale: input.rationale, createdAt: new Date().toISOString(),
    };
    // Gate 2 closes in the same ledger the other two gates read. Without the row
    // the approvals table holds, approving here would unblock nothing: Gate 3
    // asks that table whether the prototype was approved, and on which version.
    // The run counts as decided only once that row exists, so a write that fails
    // leaves a review the captain can decide again rather than a dead one.
    const { identityRunId: chainRunId, projectId } = record.chain;
    if (input.decision === 'approved') await this.persistLineage(record, version.id, projectId);
    await ignoringDuplicate(this.options.repository.createApproval({ ...approval, runId: chainRunId, projectId }));
    record.approval = approval;
    await this.options.repository.appendEvent({ id: randomUUID(), runId, type: 'gate2.decided', payload: { decision: approval.decision, versionId: approval.versionId, rationale: approval.rationale, chainRunId } });
    await this.persist(record);
    return this.snapshot(record);
  }

  /**
   * Writes the revisions between the approved identity and the approved
   * prototype into the project's versions, parent first. Gate 3 walks that chain
   * to check the bundle it compiles really descends from what the captain
   * approved here, and a chain with a hole in it cannot be walked.
   */
  private async persistLineage(record: PrototypeRunRecord, versionId: string, projectId: string): Promise<void> {
    for (const version of this.lineageOf(record, versionId)) {
      await ignoringDuplicate(this.options.repository.saveVersion({ id: version.id, projectId, ...(version.parentId ? { parentId: version.parentId } : {}), hash: version.hash, ir: version.ir }));
    }
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
      identityHash: identityHash(ir),
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
      cycles: outcome.cycles,
      reports: outcome.reports,
      issues: this.issues(record),
      decisions: record.decisions,
      ...(record.approval ? { approval: record.approval } : {}),
    };
  }
}
