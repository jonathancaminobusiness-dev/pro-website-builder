import type { DesignIR } from '@pwb/domain';
import type { Applier, TaskScope, VersionRecord } from '@pwb/orchestrator';
import type { CritiqueReport } from './critique.js';
import { planPatch, type PatchPlan } from './patch-planner.js';

/** The refiner runs once per cycle; the loop controller, not the refiner, decides whether a cycle is earned. */
export const REFINER_CYCLES_PER_STAGE = 1;

export interface RefineInput {
  ir: DesignIR;
  currentVersionId: string;
  reports: CritiqueReport[];
  /** The stage, role and paths this refinement may write; the gate checks all three. */
  scope: TaskScope;
  idempotencyKey: string;
}

export interface RefinementOutcome {
  plan: PatchPlan;
  version?: VersionRecord;
  /** Set when a well-formed patch was still refused by the gate, the schema or the renderer. */
  refusal?: string;
}

/**
 * The prototype refiner: it turns the critics' findings into one minimal patch, proves the patch on a
 * dry run, and lets the applier write the new immutable version. It never edits the document itself and
 * never widens the paths the task was allowed to touch.
 */
export class PrototypeRefiner {
  constructor(private readonly applier: Applier, private readonly maxPatches = 3) {}

  refine(input: RefineInput): RefinementOutcome {
    const findings = input.reports.flatMap((report) => report.projection.findings);
    const plan = planPatch({
      ir: input.ir,
      findings,
      allowedPaths: input.scope.allowedPaths,
      baseVersionId: input.currentVersionId,
      idempotencyKey: input.idempotencyKey,
      maxPatches: this.maxPatches,
    });
    if (!plan.patch) return { plan };
    try {
      this.applier.dryRun(plan.patch, input.scope, input.currentVersionId);
      return { plan, version: this.applier.apply(plan.patch, input.scope, input.currentVersionId) };
    } catch (error) {
      return { plan, refusal: error instanceof Error ? error.message : 'O aplicador recusou o patch proposto.' };
    }
  }
}
