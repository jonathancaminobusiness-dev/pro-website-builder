import {
  agentResultSchema,
  compareDivergenceMatrix,
  divergenceAxes,
  flattenTokens,
  hashJson,
  identityColorValues,
  identitySpecSchema,
  idempotencyKey,
  measuredAxisSignals,
  MINIMUM_DISTINCT_AXES,
  paletteSignature,
  stageRoles,
  stageWritablePaths,
  tokenValueIssue,
  type AgentResult,
  type AgentTask,
  type DesignIR,
  type DirectionComparison,
  type DirectionVector,
  type DivergenceSpec,
  type IdentitySpec,
  type Patch,
  type Token,
  type TokenValue,
} from '@pwb/domain';
import { lintDesign, type LintReport } from '@pwb/linter';
import { Scheduler, type TaskScope, type VersionRecord, type VersionStore } from '@pwb/orchestrator';
import type { ModelProvider, RasterProvider } from '@pwb/providers';
import { renderDesign } from '@pwb/renderer';
import { admitsGeneratedImagery, generateApprovedImagery, imageryPolicyViolations, type IdentityAsset } from './art-director.js';
import { identityAxisBrief, identityAxisBriefIds, identityAxisBriefs, type IdentityAxisBriefId } from './axes.js';
import { CandidateBranchStore, siblingsOf } from './branches.js';
import {
  belowRubric,
  blockingFindings,
  briefSpecSchema,
  critiqueReportSchema,
  directionVectorDraftSchema,
  imagePromptPlanSchemaFor,
  IDENTITY_PROMPT_VERSION,
  RUBRIC_MINIMUM,
  type BriefSpec,
  type CritiqueFinding,
  type CritiqueReport,
  type DirectionVectorDraft,
  type ImagePromptPlan,
} from './contracts.js';
import { identityCritics } from './critics.js';
import { evaluateIdentityGate, handoffOf, identityHash, type IdentityGateRecord, type IdentityGateState, type IdentityHandoff } from './gate.js';
import { briefCuratorPrompt, criticPrompt, documentSliceOf, identityDirectorPrompt, identityRefinerPrompt, imageArtDirectorPrompt } from './prompts.js';

/**
 * The write boundary is the foundation's, not this package's: the identity
 * stage may write the identity contract and the review record, and nothing
 * else. The gate re-checks it against the per-stage patch schema, so a patch
 * that reaches beyond it is refused whatever this constant says.
 */
export const IDENTITY_ALLOWED_PATHS = stageWritablePaths.identity;
/** What a worker may read. Wider than what it may write, and the same set the RunPlanner hands a stage. */
export const IDENTITY_READABLE_PATHS = ['/identity', '/pages', '/assets', '/reviewRecord'];
/** The identity stage's write scope, pinned to the stage and role the foundation assigns it. */
export const IDENTITY_TASK_SCOPE: TaskScope = { allowedPaths: IDENTITY_ALLOWED_PATHS, stage: 'identity', role: stageRoles.identity };

export interface IdentityStageDeadlines { curator: number; director: number; critic: number; refiner: number; artDirector: number; }
export const defaultIdentityDeadlines: IdentityStageDeadlines = { curator: 4 * 60_000, director: 5 * 60_000, critic: 3 * 60_000, refiner: 8 * 60_000, artDirector: 5 * 60_000 };

export interface IdentityStageOptions {
  runId: string;
  baseVersionId: string;
  briefing: string;
  provider: ModelProvider;
  store: VersionStore;
  scheduler?: Scheduler;
  raster?: RasterProvider;
  modelAlias?: string;
  deadlines?: Partial<IdentityStageDeadlines>;
  onEvent?: (type: string, payload: Record<string, unknown>) => Promise<void> | void;
  now?: () => string;
}

export interface IdentityCandidate {
  directionId: IdentityAxisBriefId;
  label: string;
  versionId: string;
  parentVersionId: string;
  identityHash: string;
  identity: IdentitySpec;
  vector: DirectionVector;
  lint: LintReport;
  refinedFromVersionId?: string;
  blocking: CritiqueFinding[];
  scores: CritiqueScore[];
  rubricGaps: RubricGap[];
  abstained: boolean;
  imagePlan?: ImagePromptPlan;
  imageryViolations: string[];
}

export interface DivergenceOutcome { pairs: DirectionComparison[]; passed: boolean; blockedPairs: string[]; }

export interface CritiqueScore { criticId: string; dimension: string; score: number; }
export interface RubricGap { dimension: string; score: number; evidence: string; }

/** What the critics said about the fan-out as a whole, which belongs to no single card. */
export interface SetCritique { scores: CritiqueScore[]; rubricGaps: RubricGap[]; blocking: CritiqueFinding[]; abstained: boolean; }

function scoresOf(reports: CritiqueReport[]): CritiqueScore[] {
  return reports.flatMap((report) => report.scores.map((entry) => ({ criticId: report.criticId, dimension: entry.dimension, score: entry.score })));
}

export interface IdentityStageResult {
  runId: string;
  baseVersionId: string;
  brief: BriefSpec;
  candidates: IdentityCandidate[];
  critiques: CritiqueReport[];
  setCritique: SetCritique;
  divergence: DivergenceOutcome;
  gate: IdentityGateState;
  failures: Array<{ taskId: string; reason: string }>;
}

export interface IdentityApproval {
  record: IdentityGateRecord;
  assets: IdentityAsset[];
  versionId: string;
}

/** A refusal the caller can fix: a bad value, a decision the gate does not allow, a direction that is not in the run. */
export class StageError extends Error {}

/** One critic seat: the critic that was asked and the subject it was asked about. */
function criticSeat(report: CritiqueReport): string {
  return `${report.criticId}|${report.subject.kind === 'direction' ? report.subject.directionId : 'matrix'}`;
}

/** The validation errors a corrective re-invocation has to repair, or undefined when the artefact already fits its schema. */
function artifactProblem(schema: { parse: (value: unknown) => unknown }, artifact: unknown): string | undefined {
  if (artifact === undefined) return 'The answer carried no artifact at all.';
  try { schema.parse(artifact); return undefined; }
  catch (error) { return error instanceof Error ? error.message : 'The artifact does not match its schema.'; }
}

function requireArtifact<T>(schema: { parse: (value: unknown) => T }, artifact: unknown, taskId: string, what: string): T {
  if (artifact === undefined) throw new StageError(`Task ${taskId} returned no ${what}.`);
  try { return schema.parse(artifact); }
  catch (error) { throw new StageError(`Task ${taskId} returned a ${what} that does not match its schema: ${error instanceof Error ? error.message : 'unknown error'}`); }
}

/**
 * The identity stage: one serial preparation step, a real three-way fan-out,
 * parallel read-only critics, deterministic checks, at most one refinement
 * cycle, and then a human gate. Parallelism is by contract — three directors
 * open three branches that are never merged — and the only writer of a version
 * is an `Applier`.
 *
 * Nothing here starts a model on its own. A caller runs this in response to an
 * explicit captain action, and no credential is read, logged or stored.
 */
export class IdentityStage {
  private readonly scheduler: Scheduler;
  private readonly branches: CandidateBranchStore;
  private readonly deadlines: IdentityStageDeadlines;
  private readonly modelAlias: string;
  private readonly now: () => string;

  private brief: BriefSpec | undefined;
  private candidates: IdentityCandidate[] = [];
  private critiques: CritiqueReport[] = [];
  private setCritique: SetCritique = { scores: [], rubricGaps: [], blocking: [], abstained: false };
  private divergence: DivergenceOutcome = { pairs: [], passed: false, blockedPairs: [] };
  private failures: Array<{ taskId: string; reason: string }> = [];
  private gateRecord: IdentityGateRecord | undefined;
  private approvedIr: DesignIR | undefined;
  private currentVersionId: string | undefined;
  private approvedAssets: IdentityAsset[] = [];
  private refinementCyclesUsed = 0;

  constructor(private readonly options: IdentityStageOptions) {
    this.scheduler = options.scheduler ?? new Scheduler();
    this.branches = new CandidateBranchStore(options.store);
    this.deadlines = { ...defaultIdentityDeadlines, ...options.deadlines };
    this.modelAlias = options.modelAlias ?? 'claude-local';
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Runs the whole stage up to, and not through, the captain's decision. */
  async run(signal?: AbortSignal): Promise<IdentityStageResult> {
    await this.record('identity.stage.started', { runId: this.options.runId, baseVersionId: this.options.baseVersionId, promptVersion: IDENTITY_PROMPT_VERSION });
    this.brief = await this.curate(signal);
    this.candidates = await this.direct(this.brief, signal);
    this.divergence = this.measureDivergence();
    this.critiques = await this.critique(this.brief, signal);
    this.applyCritiqueToCandidates();
    this.candidates = await this.refine(this.brief, signal);
    await this.syncMatrix();
    this.divergence = this.measureDivergence();
    await this.recritiqueRefined(this.brief, signal);
    await this.planImagery(this.brief, signal);
    await this.record('identity.stage.gate_opened', { runId: this.options.runId, directions: this.candidates.map((candidate) => candidate.directionId), divergencePassed: this.divergence.passed });
    return this.snapshot();
  }

  snapshot(): IdentityStageResult {
    if (!this.brief) throw new StageError('The identity stage has not produced a brief yet.');
    return {
      runId: this.options.runId,
      baseVersionId: this.options.baseVersionId,
      brief: this.brief,
      candidates: this.candidates.map((candidate) => structuredClone(candidate)),
      critiques: this.critiques.map((report) => structuredClone(report)),
      setCritique: structuredClone(this.setCritique),
      divergence: structuredClone(this.divergence),
      gate: this.gateState(),
      failures: [...this.failures],
    };
  }

  gateState(): IdentityGateState {
    if (!this.gateRecord || !this.approvedIr) return evaluateIdentityGate(undefined, undefined, this.branches.version(this.options.baseVersionId).ir);
    const current = this.options.store.get(this.currentVersionId ?? this.gateRecord.versionId)?.ir ?? this.approvedIr;
    return evaluateIdentityGate(this.gateRecord, this.approvedIr, current);
  }

  /** The version the approved identity lives on right now, which a token change moves forward. */
  get approvedVersionId(): string | undefined { return this.currentVersionId ?? this.gateRecord?.versionId; }

  /** The typed handoff the prototype stage plans against; undefined until the captain decides. */
  handoff(gate: IdentityGateState = this.gateState()): IdentityHandoff | undefined {
    const versionId = this.approvedVersionId;
    return versionId ? handoffOf(gate, versionId, this.approvedAssets) : undefined;
  }

  // ---------------------------------------------------------------- step 1

  private async curate(signal?: AbortSignal): Promise<BriefSpec> {
    const base = this.branches.version(this.options.baseVersionId);
    const task = this.task({ id: 'identity-curator', role: 'curator', deadlineMs: this.deadlines.curator, brief: briefCuratorPrompt(this.options.briefing), allowedPaths: [], ir: base.ir });
    const [result] = await this.dispatch([task], signal, () => briefSpecSchema);
    if (!result) throw new StageError('The brief curator produced no result.');
    return requireArtifact(briefSpecSchema, result.artifact, task.id, 'BriefSpec');
  }

  // ---------------------------------------------------------------- step 2

  private async direct(brief: BriefSpec, signal?: AbortSignal): Promise<IdentityCandidate[]> {
    const base = this.branches.version(this.options.baseVersionId);
    const tasks = identityAxisBriefs.map((seat) => this.task({
      id: `identity-director-${seat.id}`,
      role: 'director',
      deadlineMs: this.deadlines.director,
      brief: identityDirectorPrompt({ brief, axisBriefId: seat.id, baseVersionId: base.id, allowedPaths: IDENTITY_ALLOWED_PATHS, currentIdentity: base.ir.identity }),
      allowedPaths: IDENTITY_ALLOWED_PATHS,
      ir: base.ir,
    }));
    const results = await this.dispatch(tasks, signal, () => directionVectorDraftSchema);

    // One director failing its schema is a recoverable loss of a branch, not the
    // loss of the stage; the matrix still needs at least two directions to exist.
    const drafts: Array<{ seatId: IdentityAxisBriefId; draft: DirectionVectorDraft; identity: IdentitySpec; task: AgentTask }> = [];
    for (const result of results) {
      const seatId = result.taskId.replace('identity-director-', '') as IdentityAxisBriefId;
      try {
        const draft = requireArtifact(directionVectorDraftSchema, result.artifact, result.taskId, 'DirectionVectorDraft');
        if (draft.directionId !== seatId) throw new StageError(`Director ${result.taskId} answered for direction ${draft.directionId} instead of its own seat.`);
        drafts.push({ seatId, draft, identity: this.identityFromProposal(result.taskId, result.proposal), task: tasks.find((entry) => entry.id === result.taskId)! });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The director answer did not validate.';
        this.failures.push({ taskId: result.taskId, reason });
        await this.record('identity.candidate.rejected', { directionId: seatId, reason });
      }
    }
    if (drafts.length < 2) throw new StageError(`The identity fan-out produced ${drafts.length} usable directions; a divergence matrix needs at least two.`);
    // The directors answer in whatever order they finish; the set they form is
    // ordered by seat, so the same three answers always produce the same matrix,
    // the same version hashes and the same three cards.
    drafts.sort((a, b) => identityAxisBriefIds.indexOf(a.seatId) - identityAxisBriefIds.indexOf(b.seatId));

    // Deterministic fan-in: the matrix is a fact about the set, so the stage
    // builds it from assigned keys, model descriptors and measured documents.
    const matrix = drafts.map((entry) => this.vectorOf(entry.seatId, entry.draft, entry.identity));
    const constants = [...new Set(drafts.flatMap((entry) => entry.draft.constants))].sort();
    const incompatibilities = drafts.flatMap((entry) => entry.draft.incompatibilities);

    const candidates: IdentityCandidate[] = [];
    for (const entry of drafts) {
      try {
        const spec: DivergenceSpec = { directionId: entry.seatId, matrix, constants, incompatibilities };
        const identity = identitySpecSchema.parse({
          ...entry.identity,
          direction: {
            ...entry.identity.direction,
            divergence: spec,
            rejectedAlternatives: matrix.filter((vector) => vector.directionId !== entry.seatId).map((vector) => ({ directionId: vector.directionId, label: vector.label, reason: 'Alternative branch kept for the captain to compare; never merged into this one.' })),
          },
        });
        const patch: Patch = {
          operations: [{ op: 'replace', path: '/identity', value: identity }],
          baseVersionId: entry.task.baseVersionId,
          touchedPaths: ['/identity'],
          rationale: `Direction ${entry.seatId}: ${identity.direction.rationale}`,
          confidence: 1,
          stage: 'identity',
          role: stageRoles.identity,
          idempotencyKey: idempotencyKey(entry.task),
        };
        const version = this.branches.applierFor(entry.seatId).apply(patch, IDENTITY_TASK_SCOPE, entry.task.baseVersionId);
        renderDesign(version.ir);
        candidates.push(this.candidateOf(entry.seatId, version));
        await this.record('identity.candidate.opened', { directionId: entry.seatId, versionId: version.id, parentVersionId: version.parentId, identityHash: identityHash(version.ir) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The director branch could not be opened.';
        this.failures.push({ taskId: entry.task.id, reason });
        await this.record('identity.candidate.rejected', { directionId: entry.seatId, reason });
      }
    }
    if (candidates.length < 2) throw new StageError(`The identity fan-out produced ${candidates.length} usable directions; a divergence matrix needs at least two.`);
    siblingsOf(this.options.store, candidates.map((candidate) => candidate.versionId));
    return candidates;
  }

  private identityFromProposal(taskId: string, proposal: Patch | undefined): IdentitySpec {
    if (!proposal) throw new StageError(`Director ${taskId} returned no proposal.`);
    if (proposal.operations.length !== 1) throw new StageError(`Director ${taskId} proposed ${proposal.operations.length} operations; the identity stage accepts exactly one replace of /identity.`);
    const [operation] = proposal.operations;
    if (!operation || operation.op !== 'replace' || operation.path !== '/identity') throw new StageError(`Director ${taskId} proposed ${operation?.op ?? 'nothing'} at ${operation?.path ?? 'no path'}; the identity stage accepts exactly one replace of /identity.`);
    return identitySpecSchema.parse(operation.value);
  }

  /**
   * The seat assigns the strategy the director had to argue; the document says
   * what it actually built. Both travel on the vector, so DIV-030 can refuse a
   * pair that converged even though their seats were opposed.
   */
  private vectorOf(seatId: IdentityAxisBriefId, draft: DirectionVectorDraft, identity: IdentitySpec): DirectionVector {
    const seat = identityAxisBrief(seatId);
    const signals = measuredAxisSignals(identity);
    return {
      directionId: seatId,
      label: draft.label,
      axes: Object.fromEntries(divergenceAxes.map((axis) => [axis, { key: seat.required[axis], descriptor: draft.descriptors[axis], signal: signals[axis] }])) as DirectionVector['axes'],
      paletteSignature: paletteSignature(identityColorValues(identity)),
    };
  }

  private candidateOf(directionId: IdentityAxisBriefId, version: VersionRecord, previous?: IdentityCandidate, refinedFrom?: string): IdentityCandidate {
    const vector = version.ir.identity.direction.divergence?.matrix.find((entry) => entry.directionId === directionId);
    if (!vector) throw new StageError(`Candidate ${directionId} carries no divergence vector, so it cannot enter Gate 1.`);
    return {
      directionId,
      label: vector.label,
      versionId: version.id,
      parentVersionId: version.parentId ?? this.options.baseVersionId,
      identityHash: identityHash(version.ir),
      identity: version.ir.identity,
      vector,
      lint: lintDesign(version.ir),
      ...((refinedFrom ?? previous?.refinedFromVersionId) ? { refinedFromVersionId: (refinedFrom ?? previous!.refinedFromVersionId)! } : {}),
      blocking: previous?.blocking ?? [],
      scores: previous?.scores ?? [],
      rubricGaps: previous?.rubricGaps ?? [],
      abstained: previous?.abstained ?? false,
      ...(previous?.imagePlan ? { imagePlan: previous.imagePlan } : {}),
      imageryViolations: previous?.imageryViolations ?? [],
    };
  }

  // ---------------------------------------------------------------- step 3

  private measureDivergence(): DivergenceOutcome {
    const matrix = this.candidates.map((candidate) => candidate.vector);
    if (matrix.length < 2) return { pairs: [], passed: false, blockedPairs: ['A divergence matrix needs at least two directions.'] };
    const pairs = compareDivergenceMatrix(matrix);
    const blockedPairs = pairs
      .filter((pair) => pair.distinctAxes.length < MINIMUM_DISTINCT_AXES)
      .map((pair) => `${pair.a} and ${pair.b} differ on ${pair.distinctAxes.length} of ${MINIMUM_DISTINCT_AXES} axes${pair.hueOnlyColor ? '; the colour difference is only a hue rotation' : ''}.`);
    return { pairs, passed: blockedPairs.length === 0, blockedPairs };
  }

  // ---------------------------------------------------------------- step 4

  private async critique(brief: BriefSpec, signal?: AbortSignal, only?: IdentityAxisBriefId[]): Promise<CritiqueReport[]> {
    const subjects = only ? this.candidates.filter((candidate) => only.includes(candidate.directionId)) : this.candidates;
    const tasks: AgentTask[] = [];
    const seatOf = new Map<string, { criticId: string; dimension: CritiqueReport['dimension']; subject: CritiqueReport['subject'] }>();
    for (const critic of identityCritics) {
      if (critic.scope === 'matrix') {
        const first = this.candidates[0];
        if (!first || only) continue;
        seatOf.set(`identity-critic-${critic.id}`, { criticId: critic.id, dimension: critic.dimension, subject: { kind: 'matrix' } });
        tasks.push(this.task({
          id: `identity-critic-${critic.id}`,
          role: 'critic',
          deadlineMs: this.deadlines.critic,
          allowedPaths: [],
          ir: this.branches.version(first.versionId).ir,
          brief: criticPrompt({ criticId: critic.id, dimension: critic.dimension, brief, subject: { kind: 'matrix' }, rubric: critic.rubric, vetoes: critic.vetoes, document: { matrix: this.candidates.map((candidate) => candidate.vector), constants: first.identity.direction.divergence?.constants ?? [], comparisons: this.divergence.pairs } }),
        }));
        continue;
      }
      for (const candidate of subjects) {
        seatOf.set(`identity-critic-${critic.id}-${candidate.directionId}`, { criticId: critic.id, dimension: critic.dimension, subject: { kind: 'direction', directionId: candidate.directionId } });
        tasks.push(this.task({
          id: `identity-critic-${critic.id}-${candidate.directionId}`,
          role: 'critic',
          deadlineMs: this.deadlines.critic,
          allowedPaths: [],
          ir: this.branches.version(candidate.versionId).ir,
          brief: criticPrompt({ criticId: critic.id, dimension: critic.dimension, brief, subject: { kind: 'direction', directionId: candidate.directionId }, rubric: critic.rubric, vetoes: critic.vetoes, document: candidate.identity }),
        }));
      }
    }
    const results = await this.dispatch(tasks, signal, () => critiqueReportSchema);
    const reports: CritiqueReport[] = [];
    for (const result of results) {
      if (result.proposal) {
        this.failures.push({ taskId: result.taskId, reason: 'A critic returned a patch; critics are read-only and their proposals are discarded.' });
        await this.record('identity.critic.rejected', { taskId: result.taskId, reason: 'critic proposed a patch' });
        continue;
      }
      // A critic is advisory, so an answer that misses its schema costs its own
      // report and the captain's attention, never the whole stage.
      try {
        // The critic, its dimension and the subject are the seat the task was
        // issued for, not what the answer says they are: attribution is a fact
        // the stage knows. A seat scores only the rubric it was given, so a
        // score in another dimension is not the seat's to give; what it found
        // and whether it abstained still reach the candidate either way.
        const report = requireArtifact(critiqueReportSchema, result.artifact, result.taskId, 'CritiqueReport');
        const seat = seatOf.get(result.taskId)!;
        reports.push({ ...report, ...seat, scores: report.scores.filter((entry) => entry.dimension === seat.dimension) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The critique did not validate.';
        this.failures.push({ taskId: result.taskId, reason });
        await this.record('identity.critic.rejected', { taskId: result.taskId, reason });
      }
    }
    await this.record('identity.critique.completed', { reports: reports.length, abstained: reports.filter((report) => report.abstain).length });
    return reports;
  }

  /**
   * A matrix critic judges the fan-out as a whole, and what it says stays there:
   * a set-level score, veto or abstention is about the set, not about any one
   * direction, so no per-direction repair can clear it. It is recorded once,
   * blocks the gate once and never selects a candidate for refinement.
   */
  private applyCritiqueToCandidates(): void {
    const forSet = this.critiques.filter((report) => report.subject.kind === 'matrix');
    this.setCritique = {
      scores: scoresOf(forSet),
      rubricGaps: forSet.flatMap(belowRubric),
      blocking: forSet.flatMap(blockingFindings),
      abstained: forSet.some((report) => report.abstain),
    };
    this.candidates = this.candidates.map((candidate) => {
      const own = this.critiques.filter((report) => report.subject.kind === 'direction' && report.subject.directionId === candidate.directionId);
      return {
        ...candidate,
        blocking: own.flatMap(blockingFindings),
        scores: scoresOf(own),
        rubricGaps: own.flatMap(belowRubric),
        abstained: own.some((report) => report.abstain),
      };
    });
  }

  /**
   * What the refiner is told about a rubric gap: the dimension and score that
   * blocks the gate, plus the evidence the critic wrote for that score and the
   * summary of the report it came from, so the repair has a cause to act on.
   */
  private rubricFindingsFor(directionId: string): Array<RubricGap & { criticId: string; summary: string }> {
    return this.critiques
      .filter((report) => report.subject.kind === 'direction' && report.subject.directionId === directionId)
      .flatMap((report) => belowRubric(report).map((gap) => ({ ...gap, criticId: report.criticId, summary: report.summary })));
  }

  /**
   * The other half of the single refinement cycle: a repaired direction is read
   * again by the same critics, so what the captain sees at Gate 1 describes the
   * version in front of them and a repair can actually clear a blocker.
   */
  private async recritiqueRefined(brief: BriefSpec, signal?: AbortSignal): Promise<void> {
    const refined = this.candidates.filter((candidate) => candidate.refinedFromVersionId).map((candidate) => candidate.directionId);
    if (refined.length === 0) return;
    const reports = await this.critique(brief, signal, refined);
    // A seat that did not answer the second time keeps what it found the first
    // time: a veto disappears only when the same critic has read the repair, and
    // an answer that scored nothing in its own rubric has not read that rubric,
    // so the scores it did not give stay as they were.
    const scoredBefore = new Map(this.critiques.map((report) => [criticSeat(report), report.scores]));
    const reread = reports.map((report) => (report.scores.length > 0 ? report : { ...report, scores: scoredBefore.get(criticSeat(report)) ?? [] }));
    const seats = new Set(reread.map(criticSeat));
    this.critiques = [...this.critiques.filter((report) => !seats.has(criticSeat(report))), ...reread];
    this.applyCritiqueToCandidates();
  }

  // ---------------------------------------------------------------- step 5

  private async refine(brief: BriefSpec, signal?: AbortSignal): Promise<IdentityCandidate[]> {
    if (this.refinementCyclesUsed >= 1) return this.candidates;
    const needing = this.candidates.filter((candidate) => candidate.blocking.length > 0 || candidate.rubricGaps.length > 0 || candidate.lint.errorCount > 0);
    if (needing.length === 0) return this.candidates;
    this.refinementCyclesUsed += 1;
    const refined = [...this.candidates];
    // Serial on purpose: a refinement writes a version, and only one writer at a time touches a branch.
    for (const candidate of needing) {
      const base = this.branches.version(candidate.versionId);
      const task = this.task({
        id: `identity-refiner-${candidate.directionId}`,
        role: 'refiner',
        deadlineMs: this.deadlines.refiner,
        allowedPaths: IDENTITY_ALLOWED_PATHS,
        ir: base.ir,
        baseVersionId: base.id,
        brief: identityRefinerPrompt({ brief, directionId: candidate.directionId, baseVersionId: base.id, allowedPaths: IDENTITY_ALLOWED_PATHS, identity: base.ir.identity, findings: { critique: candidate.blocking, rubric: this.rubricFindingsFor(candidate.directionId), lint: candidate.lint.findings } }),
      });
      const [result] = await this.dispatch([task], signal);
      if (!result?.proposal) { this.failures.push({ taskId: task.id, reason: 'The refiner produced no proposal; the candidate keeps its findings for the captain.' }); continue; }
      let version: VersionRecord;
      try {
        const identity = this.repairedIdentity(task.id, result.proposal, base.ir.identity);
        const patch: Patch = { ...result.proposal, operations: [{ op: 'replace', path: '/identity', value: identity }], baseVersionId: base.id, touchedPaths: ['/identity'], stage: 'identity', role: stageRoles.identity, idempotencyKey: idempotencyKey(task) };
        version = this.branches.applierFor(candidate.directionId).apply(patch, IDENTITY_TASK_SCOPE, base.id);
        renderDesign(version.ir);
      } catch (error) {
        this.failures.push({ taskId: task.id, reason: error instanceof Error ? error.message : 'The refinement did not validate.' });
        await this.record('identity.refine.rejected', { directionId: candidate.directionId, reason: error instanceof Error ? error.message : 'invalid refinement' });
        continue;
      }
      const index = refined.findIndex((entry) => entry.directionId === candidate.directionId);
      refined[index] = this.candidateOf(candidate.directionId, version, candidate, candidate.versionId);
      await this.record('identity.refine.applied', { directionId: candidate.directionId, fromVersionId: candidate.versionId, versionId: version.id });
    }
    return refined;
  }

  /**
   * A refinement repairs findings; it does not get to redraw the fan-out. The
   * divergence matrix and the rejected alternatives are facts about the set, so
   * the stage re-imposes them, and the token vocabulary the pages resolve
   * against has to survive the repair intact.
   */
  private repairedIdentity(taskId: string, proposal: Patch, before: IdentitySpec): IdentitySpec {
    const proposed = this.identityFromProposal(taskId, proposal);
    const pathsBefore = [...flattenTokens(before.tokens).keys()].sort();
    const pathsAfter = [...flattenTokens(proposed.tokens).keys()].sort();
    if (pathsBefore.join('|') !== pathsAfter.join('|')) {
      throw new StageError(`Refiner ${taskId} changed the token vocabulary; a repair may change what a token means, not which tokens exist.`);
    }
    return identitySpecSchema.parse({
      ...proposed,
      direction: { ...proposed.direction, ...(before.direction.divergence ? { divergence: before.direction.divergence } : {}), rejectedAlternatives: before.direction.rejectedAlternatives },
    });
  }

  /**
   * Deterministic fan-in, run again after the refinement cycle. A repair can
   * move a palette, and every branch carries the whole matrix so that DIV-030
   * can be checked from any one of them; when the measured vectors move, each
   * branch gets the current matrix written back through its own applier.
   */
  private async syncMatrix(): Promise<void> {
    if (this.candidates.length < 2) return;
    const matrix = this.candidates.map((candidate) => this.vectorOf(candidate.directionId, {
      schemaVersion: 1,
      directionId: candidate.directionId,
      label: candidate.vector.label,
      descriptors: Object.fromEntries(divergenceAxes.map((axis) => [axis, candidate.vector.axes[axis].descriptor])) as DirectionVectorDraft['descriptors'],
      constants: candidate.identity.direction.divergence?.constants ?? [],
      incompatibilities: candidate.identity.direction.divergence?.incompatibilities ?? [],
    }, candidate.identity));
    const digest = hashJson(matrix);
    for (const [index, candidate] of this.candidates.entries()) {
      const current = candidate.identity.direction.divergence;
      if (current && hashJson(current.matrix) === digest) continue;
      const spec: DivergenceSpec = { directionId: candidate.directionId, matrix, constants: current?.constants ?? [], incompatibilities: current?.incompatibilities ?? [] };
      const patch: Patch = {
        operations: [{ op: 'replace', path: '/identity/direction/divergence', value: spec }],
        baseVersionId: candidate.versionId,
        touchedPaths: ['/identity/direction/divergence'],
        rationale: 'Deterministic fan-in: the divergence matrix is re-measured after the refinement cycle.',
        confidence: 1,
        stage: 'identity',
        role: stageRoles.identity,
        idempotencyKey: hashJson({ directionId: candidate.directionId, base: candidate.versionId, digest }),
      };
      const version = this.branches.applierFor(candidate.directionId).apply(patch, IDENTITY_TASK_SCOPE, candidate.versionId);
      this.candidates[index] = this.candidateOf(candidate.directionId, version, candidate);
      await this.record('identity.matrix.synced', { directionId: candidate.directionId, versionId: version.id });
    }
  }

  // ---------------------------------------------------------------- step 6

  private async planImagery(brief: BriefSpec, signal?: AbortSignal): Promise<void> {
    // A direction whose contract admits no generated source is not asked for a
    // plan at all: nothing to generate is a decision, not a blocker.
    const planning = this.candidates.filter((candidate) => admitsGeneratedImagery(candidate.identity));
    const tasks = planning.map((candidate) => this.task({
      id: `identity-art-director-${candidate.directionId}`,
      role: 'art-director',
      deadlineMs: this.deadlines.artDirector,
      allowedPaths: [],
      ir: this.branches.version(candidate.versionId).ir,
      brief: imageArtDirectorPrompt({ brief, directionId: candidate.directionId, identity: candidate.identity }),
    }));
    // The seat the task was issued for is the only direction the plan can be
    // about, so it is pinned in that task's schema: a plan written for another
    // direction is a schema violation and gets the one corrective re-invocation.
    const seatOfTask = (taskId: string) => taskId.replace('identity-art-director-', '') as IdentityAxisBriefId;
    const results = await this.dispatch(tasks, signal, (task) => imagePromptPlanSchemaFor(seatOfTask(task.id)));
    for (const result of results) {
      const directionId = seatOfTask(result.taskId);
      const index = this.candidates.findIndex((candidate) => candidate.directionId === directionId);
      if (index < 0) continue;
      try {
        const plan = requireArtifact(imagePromptPlanSchemaFor(directionId), result.artifact, result.taskId, 'ImagePromptPlan');
        const candidate = this.candidates[index]!;
        this.candidates[index] = { ...candidate, imagePlan: plan, imageryViolations: imageryPolicyViolations(plan, this.branches.version(candidate.versionId).ir) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The image prompt plan did not validate.';
        this.failures.push({ taskId: result.taskId, reason });
        await this.record('identity.imagery.rejected', { directionId, reason });
      }
    }
    await this.record('identity.imagery.planned', { plans: this.candidates.filter((candidate) => candidate.imagePlan).length, skipped: this.candidates.length - planning.length, generated: 0 });
  }

  // ---------------------------------------------------------------- gate

  /**
   * Gate 1. The captain picks one branch; the other two stay in the store as
   * alternatives and are never merged. Raster generation happens here and only
   * here, for the approved direction alone.
   */
  async approve(input: { directionId: string; rationale: string; approverRole: string; overrideRationale?: string; signal?: AbortSignal }): Promise<IdentityApproval> {
    if (input.approverRole !== 'captain') throw new StageError('Only the captain can decide Gate 1 in v1.');
    const candidate = this.candidates.find((entry) => entry.directionId === input.directionId);
    if (!candidate) throw new StageError(`Direction ${input.directionId} is not one of this run's candidates.`);
    const before = this.gateState();
    if (before.state === 'closed') throw new StageError(`Gate 1 is already closed for ${before.record.directionId}; change the identity to reopen it before deciding again.`);
    // Re-approval is what closes a gate that a token change reopened, and it can
    // only confirm the direction that was already chosen: picking a different
    // branch after the fact would leave the approved lineage behind.
    if (before.state === 'reopened' && before.record.directionId !== input.directionId) {
      throw new StageError(`Gate 1 was reopened for ${before.record.directionId}; a different direction cannot be approved onto that lineage.`);
    }
    const blockers = [
      ...lintDesign(this.branches.version(before.state === 'reopened' ? this.approvedVersionId! : candidate.versionId).ir).findings.filter((finding) => finding.severity === 'error').map((finding) => `${finding.id} at ${finding.path}: ${finding.message}`),
      ...this.divergence.blockedPairs,
      ...this.setCritique.rubricGaps.map((gap) => `Rubric ${gap.dimension} scored ${gap.score} for the fan-out as a whole, below the absolute minimum of ${RUBRIC_MINIMUM}: ${gap.evidence}`),
      ...this.setCritique.blocking.map((finding) => `${finding.id} about the fan-out as a whole: ${finding.observation}`),
      ...candidate.blocking.map((finding) => `${finding.id}: ${finding.observation}`),
      ...candidate.rubricGaps.map((gap) => `Rubric ${gap.dimension} scored ${gap.score}, below the absolute minimum of ${RUBRIC_MINIMUM}.`),
      ...candidate.imageryViolations,
    ];
    if (blockers.length > 0 && !(input.overrideRationale ?? '').trim()) {
      throw new StageError(`Gate 1 is blocked for ${input.directionId} and automatic selection is not allowed. Approve with a written override or send the direction back:\n- ${blockers.join('\n- ')}`);
    }
    const version = this.retireDivergence(candidate.directionId, before.state === 'reopened' ? this.approvedVersionId! : candidate.versionId);
    const record: IdentityGateRecord = {
      runId: this.options.runId,
      directionId: candidate.directionId,
      versionId: version.id,
      versionHash: version.hash,
      identityHash: identityHash(version.ir),
      approverRole: 'captain',
      rationale: input.rationale,
      ...(input.overrideRationale ? { overrideRationale: input.overrideRationale } : {}),
      approvedAt: this.now(),
    };
    this.gateRecord = record;
    this.approvedIr = version.ir;
    this.currentVersionId = version.id;
    await this.record('identity.gate.approved', { directionId: record.directionId, versionId: record.versionId, identityHash: record.identityHash, blockers, overridden: blockers.length > 0, ...(record.overrideRationale ? { overrideRationale: record.overrideRationale } : {}) });

    // Imagery for the approved direction only. The identity stage may write the
    // identity contract and the review record, never `/assets`, so the generated
    // assets travel on the handoff with their provenance and licence and are
    // placed in the ledger by the stage that owns page media.
    let assets: IdentityAsset[] = [];
    if (candidate.imagePlan && this.options.raster) {
      const generated = await generateApprovedImagery(candidate.imagePlan, { provider: this.options.raster, identityVersionId: version.id, identity: version.ir.identity, existing: this.approvedAssets, ...(input.signal ? { signal: input.signal } : {}) });
      assets = generated.assets;
      this.approvedAssets = assets;
      await this.record('identity.imagery.generated', { directionId: candidate.directionId, assets: assets.map((asset) => ({ id: asset.id, status: asset.status, license: asset.provenance.license, hash: asset.provenance.hash })) });
    }
    return { record, assets, versionId: version.id };
  }

  /**
   * Approving ends the comparison. The chosen identity keeps `rejectedAlternatives`
   * as the durable record of what it beat, but the live divergence matrix is
   * retired: it described a fan-out that no longer exists, and leaving it in place
   * would make DIV-030 police a set of one and block every later token change.
   */
  private retireDivergence(directionId: string, versionId: string): VersionRecord {
    const current = this.branches.version(versionId);
    if (!current.ir.identity.direction.divergence) return current;
    const { divergence, ...direction } = current.ir.identity.direction;
    const patch: Patch = {
      operations: [{ op: 'remove', path: '/identity/direction/divergence' }],
      baseVersionId: versionId,
      touchedPaths: ['/identity/direction/divergence'],
      rationale: `Gate 1 chose ${directionId}; the divergence matrix becomes history in rejectedAlternatives (${direction.rejectedAlternatives.map((entry) => entry.directionId).join(', ') || 'none'}).`,
      confidence: 1,
      stage: 'identity',
      role: stageRoles.identity,
      idempotencyKey: hashJson({ retire: versionId, directionId }),
    };
    const settled = this.branches.applierFor(directionId).apply(patch, IDENTITY_TASK_SCOPE, versionId);
    renderDesign(settled.ir);
    return settled;
  }

  /**
   * A token change made after Gate 1. It goes through the same `Applier` as
   * everything else, so it produces a new immutable version whose identity hash
   * no longer matches the approved one; the derived gate state then reads
   * `reopened` and names the renders the change made unreachable. No new
   * subsystem is involved — the approval record is the only bookkeeping.
   */
  async changeToken(input: { tokenPath: string; value: TokenValue; rationale: string }): Promise<{ versionId: string; gate: IdentityGateState }> {
    if (!this.gateRecord) throw new StageError('There is no approved identity to change yet.');
    const baseId = this.approvedVersionId!;
    const base = this.branches.version(baseId);
    const pointer = `/identity/tokens/${input.tokenPath.split('.').join('/')}`;
    const before = flattenTokens(base.ir.identity.tokens).get(input.tokenPath);
    if (!before) throw new StageError(`Token ${input.tokenPath} is not defined by the approved identity.`);
    // The approved token keeps its type: a change moves what a token means, never
    // what kind of thing it is.
    const problem = tokenValueIssue(before.$type, input.value);
    if (problem) throw new StageError(`Token ${input.tokenPath} cannot take this value. ${problem}`);
    const token: Token = { ...before, $value: input.value };
    const patch: Patch = {
      operations: [{ op: 'replace', path: pointer, value: token }],
      baseVersionId: baseId,
      touchedPaths: [pointer],
      rationale: input.rationale,
      confidence: 1,
      stage: 'identity',
      role: stageRoles.identity,
      idempotencyKey: hashJson({ base: baseId, pointer, value: token }),
    };
    // The gate bucket only closes over a change that is known to work: a value
    // whose document cannot render is refused before anything is committed, so
    // the captain can type the path again.
    const applier = this.branches.applierFor(this.gateRecord.directionId);
    try { renderDesign(applier.dryRun(patch, IDENTITY_TASK_SCOPE, baseId).next); }
    catch (error) { throw new StageError(`Token ${input.tokenPath} cannot take this value. ${error instanceof Error ? error.message : 'The identity would stop rendering.'}`); }
    const version = applier.apply(patch, IDENTITY_TASK_SCOPE, baseId);
    this.currentVersionId = version.id;
    const gate = this.gateState();
    await this.record('identity.gate.reopened', { directionId: this.gateRecord.directionId, versionId: version.id, tokenPath: input.tokenPath, staleRenderKeys: gate.state === 'reopened' ? gate.impact.staleRenderKeys.length : 0 });
    return { versionId: version.id, gate };
  }

  // ---------------------------------------------------------------- plumbing

  private task(input: { id: string; role: AgentTask['role']; deadlineMs: number; brief: string; allowedPaths: string[]; ir: DesignIR; baseVersionId?: string }): AgentTask {
    const baseVersionId = input.baseVersionId ?? this.options.baseVersionId;
    const documentSlice = documentSliceOf(input.ir, IDENTITY_READABLE_PATHS);
    return {
      id: input.id,
      attempt: 1,
      stage: 'identity',
      role: input.role,
      state: 'queued',
      lane: 'claude',
      baseVersionId,
      inputDigest: hashJson({ runId: this.options.runId, brief: input.brief, documentSlice }),
      promptVersion: IDENTITY_PROMPT_VERSION,
      modelAlias: this.modelAlias,
      deadlineMs: input.deadlineMs,
      allowedPaths: input.allowedPaths,
      brief: input.brief,
      documentSlice,
    };
  }

  /**
   * Runs tasks through the shared scheduler, which is what keeps the lane limits
   * and deadlines honest. When the role answers with an artefact, the scheduler's
   * settle callback validates it against that role's closed schema and spends
   * exactly one corrective re-invocation, carrying the validation errors, before
   * the answer is handed on as it is and recorded for human review.
   */
  private async dispatch(tasks: AgentTask[], signal?: AbortSignal, artifactSchema?: (task: AgentTask) => { parse: (value: unknown) => unknown }): Promise<Array<{ taskId: string; proposal: Patch | undefined; artifact: unknown }>> {
    for (const task of tasks) await this.record('identity.task.queued', { taskId: task.id, role: task.role, baseVersionId: task.baseVersionId, deadlineMs: task.deadlineMs });
    const corrections = new Map<string, string>();
    const outcome = await this.scheduler.run(tasks, async (task, taskSignal) => {
      const correction = corrections.get(task.id);
      const brief = correction ? `${task.brief}\n\n## Correção\nA resposta anterior não passou no schema desta função. Corrija exatamente estes erros e responda de novo, no mesmo formato:\n${correction}` : task.brief;
      const result = agentResultSchema.parse(await this.options.provider.propose({ ...task, brief }, taskSignal));
      if (result.status === 'failed') throw new Error(`${task.id} failed: ${result.summary}`);
      return result;
    }, {
      ...(signal ? { signal } : {}),
      ...(artifactSchema ? { settle: async (task: AgentTask, value: AgentResult) => {
        const problem = artifactProblem(artifactSchema(task), value.artifact);
        if (!problem || task.attempt > 1) return 'approved';
        corrections.set(task.id, problem);
        await this.record('identity.task.correction', { taskId: task.id, role: task.role, attempt: task.attempt, reason: problem });
        return 'rejected';
      } } : {}),
    });

    const answers: Array<{ taskId: string; proposal: Patch | undefined; artifact: unknown }> = [];
    for (const entry of outcome.results) {
      if (entry.state !== 'succeeded' || !entry.value) {
        const reason = entry.error instanceof Error ? entry.error.message : `Task ${entry.task.id} ended as ${entry.state}.`;
        this.failures.push({ taskId: entry.task.id, reason });
        await this.record('identity.task.failed', { taskId: entry.task.id, role: entry.task.role, reason });
        continue;
      }
      await this.record('identity.task.succeeded', { taskId: entry.task.id, role: entry.task.role, status: entry.value.status });
      answers.push({ taskId: entry.task.id, proposal: entry.value.proposal, artifact: entry.value.artifact });
    }
    return answers;
  }

  private async record(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.options.onEvent?.(type, payload);
  }
}
