import { agentTaskSchema, hashJson, stageRoles, stageWritablePaths, type AgentTask, type DesignIR, type IdentitySpec, type Patch } from '@pwb/domain';
import { lintDesign, type LintReport } from '@pwb/linter';
import { Applier, PatchGate, Scheduler, type TaskScope, type VersionRecord, type VersionStore } from '@pwb/orchestrator';
import { runQa, type QaReport } from '@pwb/qa-deterministic';
import type { ArchitectProvider } from './information-architect.js';
import { ARCHITECT_ALLOWED_PATHS, ARCHITECT_PROMPT_VERSION, manifestPatch } from './information-architect.js';
import type { ComposerProvider } from './section-composer.js';
import { COMPOSER_PROMPT_VERSION, compositionPatch, validateComposition } from './section-composer.js';
import { ALLOWED_PATCH_OPERATIONS, criticRegistry, PROMPT_VERSION, type CritiqueTask } from './critics.js';
import type { CritiqueProvider } from './critique-provider.js';
import { CritiqueUnavailableError } from './critique-provider.js';
import type { CritiqueReport } from './critique.js';
import { sectionAllowedPaths, type RouteManifest, type SectionPlan } from './contracts.js';
import type { EvidenceSource } from './evidence-source.js';
import { DEFAULT_LOOP_BUDGET, decideNextCycle, summariseCycle, type CycleRecord, type LoopBudget, type StopReason } from './loop.js';
import { PrototypeRefiner } from './refiner.js';

/** The paths the whole prototype stage may touch. The approved identity is never among them. */
const PROTOTYPE_ALLOWED_PATHS = [...stageWritablePaths.prototype];
/** One critic session's own deadline; the loop's tail is a whole number of waves of these. */
export const CRITIC_DEADLINE_MS = 3 * 60_000;
/** Every write this stage makes is scoped to the prototype stage and its one role. */
export const PROTOTYPE_SCOPE: TaskScope = { stage: 'prototype', role: stageRoles.prototype, allowedPaths: PROTOTYPE_ALLOWED_PATHS };

export interface PrototypeStageOptions {
  store: VersionStore;
  applier: Applier;
  scheduler: Scheduler;
  architect: ArchitectProvider;
  composer: ComposerProvider;
  critique: CritiqueProvider;
  evidence: EvidenceSource;
  brief: string;
  budget?: LoopBudget;
  now?: () => number;
  onEvent?: (type: string, payload: Record<string, unknown>) => void | Promise<void>;
}

export interface RejectedRepairRecord { findingId: string; reason: string; }

export interface PrototypeStageOutcome {
  runId: string;
  manifest: RouteManifest;
  /** The revision the stage started from, kept so the gate can show A next to B. */
  baseVersionId: string;
  architectVersionId: string;
  compositionVersionId: string;
  versionId: string;
  cycles: CycleRecord[];
  /** The container widths this run really captured, ascending; the review may not claim any other. */
  measuredViewports: number[];
  stopReason: StopReason;
  stopDetail: string;
  reports: CritiqueReport[];
  qa: QaReport;
  lint: LintReport;
  gate: 'needs_review' | 'vetoed';
  rejectedRepairs: RejectedRepairRecord[];
}

export class PrototypeStageError extends Error {
  constructor(public readonly step: string, message: string) { super(message); this.name = 'PrototypeStageError'; }
}

/**
 * The prototype stage: a serial information architect, a parallel fan-out of section composers over
 * disjoint windows, a deterministic gate that vetoes before any critic runs, four parallel critics in
 * their own sessions, and one refinement cycle per pass of a loop that always stops for a stated reason.
 */
export class PrototypeStage {
  private readonly budget: LoopBudget;
  private readonly now: () => number;
  private readonly refiner: PrototypeRefiner;

  constructor(private readonly options: PrototypeStageOptions) {
    this.budget = options.budget ?? DEFAULT_LOOP_BUDGET;
    this.now = options.now ?? (() => Date.now());
    this.refiner = new PrototypeRefiner(options.applier, this.budget.maxPatchesPerCycle);
  }

  async run(input: { runId: string; baseVersionId: string; signal?: AbortSignal }): Promise<PrototypeStageOutcome> {
    const started = this.now();
    const baseVersion = this.version(input.baseVersionId);
    const identity = baseVersion.ir.identity;

    const manifest = await this.planInformation(input, identity);
    const architectVersion = this.applyPatch(manifestPatch(manifest, identity, this.architectTask(input, identity)), { ...PROTOTYPE_SCOPE, allowedPaths: ARCHITECT_ALLOWED_PATHS }, baseVersion.id, 'information-architect');
    await this.record('prototype.manifest.applied', { runId: input.runId, versionId: architectVersion.id, routes: manifest.routes.map((route) => route.route) });

    const compositionVersion = await this.composeSections(input, manifest, architectVersion, identity);
    await this.record('prototype.sections.applied', { runId: input.runId, versionId: compositionVersion.id, sections: manifest.routes.flatMap((route) => route.sections.map((section) => section.id)) });

    let current = compositionVersion;
    const cycles: CycleRecord[] = [];
    const rejectedRepairs: RejectedRepairRecord[] = [];
    let reports: CritiqueReport[] = [];
    const measured = new Set<number>();
    let qa = await this.gateReport(current, measured, input.signal);
    let decision = { proceed: qa.vetoes.length === 0, reason: 'tier0_veto' as StopReason, detail: 'O QA determinístico vetou a revisão antes de qualquer modelo.' };

    while (decision.proceed) {
      const cycle = cycles.length + 1;
      const bundle = await this.options.evidence.collect({ ir: current.ir, versionId: current.id, ...(input.signal ? { signal: input.signal } : {}) });
      for (const entry of bundle.evidence) measured.add(entry.context.viewport);
      qa = runQa({ ir: current.ir, evidence: bundle.evidence });
      if (qa.vetoes.length > 0) {
        cycles.push(summariseCycle({ cycle, versionId: current.id, qaIssueHash: qa.issueHash, vetoes: qa.vetoes.length, reports: [], plan: { accepted: [], rejected: [] } }));
        decision = decideNextCycle(cycles, this.budget, this.now() - started);
        break;
      }
      reports = await this.critique(input, current.ir, identity, qa, bundle.captures, cycle);
      const refinement = this.refiner.refine({
        ir: current.ir, currentVersionId: current.id, reports, scope: PROTOTYPE_SCOPE,
        idempotencyKey: hashJson(['refiner', input.runId, current.id, cycle, reports]),
      });
      for (const rejection of refinement.plan.rejected) rejectedRepairs.push({ findingId: rejection.finding.id, reason: rejection.reason });
      if (refinement.refusal) {
        await this.record('prototype.refine.refused', { runId: input.runId, cycle, reason: refinement.refusal });
        rejectedRepairs.push({ findingId: `cycle-${cycle}`, reason: refinement.refusal });
      }
      cycles.push(summariseCycle({ cycle, versionId: current.id, qaIssueHash: qa.issueHash, vetoes: 0, reports, plan: refinement.plan }));
      if (refinement.version) {
        current = refinement.version;
        await this.record('prototype.refine.applied', { runId: input.runId, cycle, versionId: current.id, repairs: refinement.plan.accepted.map((repair) => repair.finding.id) });
      }
      decision = decideNextCycle(cycles, this.budget, this.now() - started);
      await this.record('prototype.cycle.decided', { runId: input.runId, cycle, reason: decision.reason, proceed: decision.proceed });
    }

    const finalQa = qa.vetoes.length > 0 ? qa : await this.gateReport(current, measured, input.signal);
    const outcome: PrototypeStageOutcome = {
      runId: input.runId,
      manifest,
      baseVersionId: baseVersion.id,
      architectVersionId: architectVersion.id,
      compositionVersionId: compositionVersion.id,
      versionId: current.id,
      cycles,
      measuredViewports: [...measured].sort((a, b) => a - b),
      stopReason: decision.reason,
      stopDetail: decision.detail,
      reports,
      qa: finalQa,
      lint: lintDesign(current.ir),
      gate: finalQa.vetoes.length > 0 ? 'vetoed' : 'needs_review',
      rejectedRepairs,
    };
    await this.record('prototype.stage.settled', { runId: input.runId, versionId: outcome.versionId, stopReason: outcome.stopReason, gate: outcome.gate, cycles: cycles.length });
    return outcome;
  }

  private async planInformation(input: { runId: string; baseVersionId: string; signal?: AbortSignal }, identity: IdentitySpec): Promise<RouteManifest> {
    const task = this.architectTask(input, identity);
    const result = await this.options.scheduler.run([task], (queued, signal) => this.options.architect.plan(queued, signal), input.signal ? { signal: input.signal } : {});
    const entry = result.results[0];
    if (!entry || entry.state !== 'succeeded' || !entry.value) {
      throw new PrototypeStageError('information-architect', entry?.error instanceof Error ? entry.error.message : 'O arquiteto de informação não produziu um manifesto.');
    }
    return entry.value;
  }

  private async composeSections(input: { runId: string; baseVersionId: string; signal?: AbortSignal }, manifest: RouteManifest, base: VersionRecord, identity: IdentitySpec): Promise<VersionRecord> {
    const sections = manifest.routes.flatMap((route) => route.sections);
    const tasks = sections.map((section) => this.composerTask(input, manifest, section, base.id, identity));
    // The scheduler reports results in completion order, so a composer is always found by the section
    // its task names, never by its position in the result list.
    const sectionOf = (taskId: string): SectionPlan => {
      const section = sections.find((candidate) => candidate.id === taskId.replace(`${input.runId}-compose-`, ''));
      if (!section) throw new PrototypeStageError('section-composer', `A tarefa ${taskId} não corresponde a nenhuma seção do manifesto.`);
      return section;
    };
    const result = await this.options.scheduler.run(tasks, async (task, signal) => {
      const section = sectionOf(task.id);
      const composition = await this.options.composer.compose(task, section, manifest, signal);
      const problems = validateComposition(composition, section, manifest, identity);
      if (problems.length > 0) throw new PrototypeStageError('section-composer', `A composição de ${section.id} viola seu contrato: ${problems.join(' ')}`);
      return compositionPatch(composition, manifest, task);
    }, input.signal ? { signal: input.signal } : {});

    const failure = result.results.find((entry) => entry.state !== 'succeeded');
    if (failure) throw new PrototypeStageError('section-composer', failure.error instanceof Error ? failure.error.message : `A seção ${failure.task.id} não produziu uma composição.`);

    // Fan-in: every composer patch is checked against the same base through the real patch gate, so an
    // overlap between two windows is refused here, and only the merged patch reaches the applier.
    const gate = new PatchGate();
    const bySection = new Map(result.results.map((entry) => [sectionOf(entry.task.id).id, entry.value!]));
    // Merging in manifest order, not completion order, also keeps the merged patch byte-identical run to run.
    const patches: Patch[] = [];
    for (const section of sections) {
      const patch = bySection.get(section.id);
      if (!patch) throw new PrototypeStageError('section-composer', `A seção ${section.id} não produziu uma composição.`);
      gate.commit(base.id, gate.validate(patch, { currentVersionId: base.id, stage: 'prototype', role: stageRoles.prototype, allowedPaths: sectionAllowedPaths(manifest, section.id) }));
      patches.push(patch);
    }
    const merged: Patch = {
      operations: patches.flatMap((patch) => patch.operations),
      baseVersionId: base.id,
      touchedPaths: patches.flatMap((patch) => patch.touchedPaths),
      rationale: patches.map((patch) => patch.rationale).join(' | '),
      confidence: Math.min(...patches.map((patch) => patch.confidence)),
      stage: 'prototype',
      role: 'composer',
      idempotencyKey: hashJson(['sections', input.runId, base.id, patches.map((patch) => patch.idempotencyKey)]),
    };
    return this.applyPatch(merged, { ...PROTOTYPE_SCOPE, allowedPaths: ['/pages/routes'] }, base.id, 'section-composer');
  }

  private async critique(input: { runId: string; signal?: AbortSignal }, ir: DesignIR, identity: IdentitySpec, qa: QaReport, captures: CritiqueTask['captures'], cycle: number): Promise<CritiqueReport[]> {
    const tier1 = qa.checks.filter((check) => check.tier === 1);
    const routeSlices = ir.pages.routes.map((page) => ({ route: page.route, title: page.title, nodes: page.nodes }));
    const tasks = criticRegistry.map((definition) => agentTaskSchema.parse({
      id: `${input.runId}-critic-${definition.dimension}-c${cycle}`,
      attempt: 1, stage: 'prototype', role: stageRoles.prototype, state: 'queued', lane: 'claude',
      baseVersionId: ir.meta.versionId, inputDigest: qa.issueHash, promptVersion: PROMPT_VERSION, modelAlias: 'claude-local',
      deadlineMs: CRITIC_DEADLINE_MS,
      allowedPaths: [],
      brief: this.options.brief,
      documentSlice: { '/identity': identity },
    } satisfies AgentTask));

    const result = await this.options.scheduler.run(tasks, async (task, signal) => {
      const dimension = criticRegistry.find((definition) => task.id.endsWith(`-critic-${definition.dimension}-c${cycle}`))!.dimension;
      const critiqueTask: CritiqueTask = {
        id: task.id, dimension, stage: 'prototype', promptVersion: PROMPT_VERSION,
        criticSessionId: `${task.id}-session`, deadlineMs: task.deadlineMs, brief: task.brief,
        identity, routeSlices, qaChecks: tier1, captures, allowedOperations: ALLOWED_PATCH_OPERATIONS,
      };
      return this.options.critique.critique(critiqueTask, signal);
    }, input.signal ? { signal: input.signal } : {});

    const reports: CritiqueReport[] = [];
    for (const entry of result.results) {
      if (entry.state === 'succeeded' && entry.value) { reports.push(entry.value); continue; }
      const reason = entry.error instanceof CritiqueUnavailableError ? `${entry.error.errorCode}: ${entry.error.message}` : entry.error instanceof Error ? entry.error.message : 'unknown';
      await this.record('prototype.critic.unavailable', { runId: input.runId, taskId: entry.task.id, reason });
      reports.push(this.uncertainReport(entry.task.id, cycle, reason));
    }
    return reports;
  }

  /** A critic that could not answer counts as uncertain, which stops the loop and escalates to the gate. */
  private uncertainReport(taskId: string, cycle: number, reason: string): CritiqueReport {
    const dimension = criticRegistry.find((definition) => taskId.endsWith(`-critic-${definition.dimension}-c${cycle}`))?.dimension ?? 'coherence';
    return {
      schemaVersion: '1', stage: 'prototype', dimension, criticSessionId: `${taskId}-session`,
      perception: { summary: 'O crítico não entregou um relatório tipado.', regions: [] },
      comprehension: { hierarchy: 'não avaliada', intent: 'não avaliada', brandAlignment: 'não avaliada' },
      projection: { verdict: 'uncertain', rubric: [{ criterion: 'disponibilidade do crítico', score: 0, evidence: `Falha registrada: ${reason}.` }], findings: [] },
    };
  }

  /**
   * The deterministic gate over the full capture matrix. Only Tier 0 rules can veto, so this still
   * stops the stage before a single model call; the Tier 1 observations ride along because they come
   * from the same evidence and the human gate needs to see them.
   */
  private async gateReport(version: VersionRecord, measured: Set<number>, signal?: AbortSignal): Promise<QaReport> {
    const bundle = await this.options.evidence.collect({ ir: version.ir, versionId: version.id, ...(signal ? { signal } : {}) });
    for (const entry of bundle.evidence) measured.add(entry.context.viewport);
    const report = runQa({ ir: version.ir, evidence: bundle.evidence });
    await this.record('prototype.qa.gate', { versionId: version.id, passed: report.passed, vetoes: report.vetoes.map((check) => check.id), observations: report.checks.length - report.vetoes.length });
    return report;
  }

  private applyPatch(patch: Patch, scope: TaskScope, currentVersionId: string, step: string): VersionRecord {
    try {
      this.options.applier.dryRun(patch, scope, currentVersionId);
      return this.options.applier.apply(patch, scope, currentVersionId);
    } catch (error) {
      throw new PrototypeStageError(step, error instanceof Error ? error.message : 'O aplicador recusou o patch.');
    }
  }

  private architectTask(input: { runId: string; baseVersionId: string }, identity: IdentitySpec): AgentTask {
    return agentTaskSchema.parse({
      id: `${input.runId}-architect`, attempt: 1, stage: 'prototype', role: stageRoles.prototype, state: 'queued', lane: 'claude',
      baseVersionId: input.baseVersionId, inputDigest: hashJson([this.options.brief, input.baseVersionId]),
      promptVersion: ARCHITECT_PROMPT_VERSION, modelAlias: 'claude-local', deadlineMs: 5 * 60_000,
      allowedPaths: ARCHITECT_ALLOWED_PATHS, brief: this.options.brief, documentSlice: { '/identity': identity },
    } satisfies AgentTask);
  }

  private composerTask(input: { runId: string }, manifest: RouteManifest, section: SectionPlan, baseVersionId: string, identity: IdentitySpec): AgentTask {
    return agentTaskSchema.parse({
      id: `${input.runId}-compose-${section.id}`, attempt: 1, stage: 'prototype', role: stageRoles.prototype, state: 'queued', lane: 'claude',
      baseVersionId, inputDigest: hashJson([section, manifest.journey]), promptVersion: COMPOSER_PROMPT_VERSION,
      modelAlias: 'claude-local', deadlineMs: 5 * 60_000, allowedPaths: sectionAllowedPaths(manifest, section.id),
      brief: this.options.brief, documentSlice: { '/identity': identity },
    } satisfies AgentTask);
  }

  private version(versionId: string): VersionRecord {
    const version = this.options.store.get(versionId);
    if (!version) throw new PrototypeStageError('start', `A revisão ${versionId} não está no repositório de versões.`);
    return version;
  }

  private async record(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.options.onEvent?.(type, payload);
  }
}
