import type { CritiqueReport } from './critique.js';
import { issueHash, rubricAverage } from './critique.js';
import type { PatchPlan } from './patch-planner.js';

/** Why the refinement loop stopped. Every branch is an explicit decision, never an exhausted retry. */
export type StopReason =
  | 'clean'
  | 'tier0_veto'
  | 'max_cycles'
  | 'repeated_issue'
  | 'improvement_below_noise'
  | 'uncertain'
  | 'no_actionable_patch'
  | 'budget_exhausted';

export interface LoopBudget {
  /** Hard ceiling of refinement cycles for one stage. */
  maxCycles: number;
  /** Causal repairs one cycle may apply. */
  maxPatchesPerCycle: number;
  /** A rubric gain smaller than this is judge noise, not progress. */
  noiseThreshold: number;
  deadlineMs: number;
}

export const DEFAULT_LOOP_BUDGET: LoopBudget = { maxCycles: 3, maxPatchesPerCycle: 3, noiseThreshold: 0.25, deadlineMs: 20 * 60_000 };

export interface CycleRecord {
  cycle: number;
  versionId: string;
  qaIssueHash: string;
  vetoes: number;
  issueHashes: string[];
  rubricAverage: number;
  verdicts: Array<CritiqueReport['projection']['verdict']>;
  appliedFindingIds: string[];
  rejectedCount: number;
}

export interface LoopDecision { proceed: boolean; reason: StopReason; detail: string; }

export function summariseCycle(input: { cycle: number; versionId: string; qaIssueHash: string; vetoes: number; reports: CritiqueReport[]; plan: PatchPlan }): CycleRecord {
  const findings = input.reports.flatMap((report) => report.projection.findings);
  return {
    cycle: input.cycle,
    versionId: input.versionId,
    qaIssueHash: input.qaIssueHash,
    vetoes: input.vetoes,
    issueHashes: [...new Set(findings.map(issueHash))].sort(),
    rubricAverage: rubricAverage(input.reports),
    verdicts: input.reports.map((report) => report.projection.verdict),
    appliedFindingIds: input.plan.accepted.map((repair) => repair.finding.id),
    rejectedCount: input.plan.rejected.length,
  };
}

function sameIssues(a: CycleRecord, b: CycleRecord): boolean {
  return a.issueHashes.length > 0 && a.issueHashes.length === b.issueHashes.length && a.issueHashes.every((hash, index) => hash === b.issueHashes[index]);
}

/**
 * Decides whether the loop has earned another cycle. The conditions are the ones the plan fixed:
 * a deterministic veto, a clean set of verdicts, an uncertain critic, the cycle ceiling, the same
 * problem twice, an improvement smaller than the judge's noise, no applicable repair, or the budget.
 * Anything that stops here is recorded as unresolved and escalated to the human gate.
 */
export function decideNextCycle(history: CycleRecord[], budget: LoopBudget, elapsedMs: number): LoopDecision {
  const latest = history[history.length - 1];
  if (!latest) return { proceed: true, reason: 'clean', detail: 'Nenhum ciclo executado ainda.' };
  if (latest.vetoes > 0) return { proceed: false, reason: 'tier0_veto', detail: `O QA determinístico vetou a revisão com ${latest.vetoes} falha(s) antes de qualquer modelo.` };
  if (latest.verdicts.length > 0 && latest.verdicts.every((verdict) => verdict === 'pass')) return { proceed: false, reason: 'clean', detail: 'Os quatro críticos aprovaram a revisão.' };
  if (latest.verdicts.includes('uncertain')) return { proceed: false, reason: 'uncertain', detail: 'Um crítico respondeu uncertain; a decisão sobe para o gate humano.' };
  if (elapsedMs >= budget.deadlineMs) return { proceed: false, reason: 'budget_exhausted', detail: `A etapa consumiu ${elapsedMs}ms do orçamento de ${budget.deadlineMs}ms.` };
  if (history.length >= budget.maxCycles) return { proceed: false, reason: 'max_cycles', detail: `A etapa atingiu o teto de ${budget.maxCycles} ciclos.` };
  const previous = history[history.length - 2];
  if (previous && sameIssues(latest, previous)) return { proceed: false, reason: 'repeated_issue', detail: 'O mesmo problema apareceu em duas rodadas seguidas.' };
  if (previous && latest.rubricAverage - previous.rubricAverage < budget.noiseThreshold) {
    return { proceed: false, reason: 'improvement_below_noise', detail: `A rubrica variou ${(latest.rubricAverage - previous.rubricAverage).toFixed(2)}, abaixo do ruído de ${budget.noiseThreshold}.` };
  }
  if (latest.appliedFindingIds.length === 0) return { proceed: false, reason: 'no_actionable_patch', detail: `Nenhum reparo aplicável nesta rodada; ${latest.rejectedCount} proposta(s) foram recusadas com motivo.` };
  return { proceed: true, reason: 'clean', detail: `Ciclo ${latest.cycle} aplicou ${latest.appliedFindingIds.length} reparo(s) causais.` };
}
