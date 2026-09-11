import { hashJson, stageRoles, stageWritablePaths, type AgentTask, type DesignIR } from '@pwb/domain';
import type { VersionStore } from './applier.js';
import { DEFAULT_MAX_ACTIVE_CLAUDE } from './scheduler.js';

export interface RunPlan { runId: string; tasks: AgentTask[]; edges: [string, string][]; }

const readablePaths = ['/identity', '/pages', '/assets', '/reviewRecord'];

const identityDirections = 3;
const identityCuratorMs = 4 * 60_000;
const identityDirectorMs = 7 * 60_000;
const identityDefaultCriticMs = 3 * 60_000;
const identityDefaultAccessibilityCriticMs = 10 * 60_000;
const identityRefinerMs = 8 * 60_000;
const identityArtDirectorMs = 5 * 60_000;
const identityHeadroomMs = 5 * 60_000;

export interface IdentityStageBudgetInput {
  curatorMs: number;
  directorMs: number;
  initialCriticMs: number[];
  refinerMs: number;
  secondCriticMs: number[];
  artDirectorMs: number;
  directionCount: number;
  maxActiveClaude: number;
  correctiveAttempts: number;
  headroomMs: number;
}

function criticDeadlineVariable(criticId: string): string {
  return `PWB_IDENTITY_CRITIC_${criticId.replaceAll('-', '_').toUpperCase()}_DEADLINE_MS`;
}

function positiveEnvironmentMs(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = Number(env[name]?.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function effectiveCriticDeadlineMs(env: NodeJS.ProcessEnv, criticId: string, fallback: number): number {
  return positiveEnvironmentMs(env, criticDeadlineVariable(criticId))
    ?? positiveEnvironmentMs(env, 'PWB_IDENTITY_CRITIC_DEADLINE_MS')
    ?? fallback;
}

function repeated(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

function claudeLaneDurationMs(durations: number[], maxActiveClaude: number): number {
  const laneEndTimes = Array.from({ length: maxActiveClaude }, () => 0);
  for (const duration of durations) {
    const lane = laneEndTimes.indexOf(Math.min(...laneEndTimes));
    laneEndTimes[lane]! += duration;
  }
  return Math.max(...laneEndTimes);
}

export function calculateIdentityStageDeadlineMs(input: IdentityStageBudgetInput): number {
  const corrected = (deadlineMs: number): number => deadlineMs * (input.correctiveAttempts + 1);
  const directorLaneMs = claudeLaneDurationMs(repeated(corrected(input.directorMs), input.directionCount), input.maxActiveClaude);
  const initialCriticLaneMs = claudeLaneDurationMs(input.initialCriticMs.map(corrected), input.maxActiveClaude);
  const secondCriticLaneMs = claudeLaneDurationMs(input.secondCriticMs.map(corrected), input.maxActiveClaude);
  const artDirectorLaneMs = claudeLaneDurationMs(repeated(corrected(input.artDirectorMs), input.directionCount), input.maxActiveClaude);
  return [
    corrected(input.curatorMs),
    directorLaneMs,
    initialCriticLaneMs,
    input.directionCount * input.refinerMs,
    secondCriticLaneMs,
    artDirectorLaneMs,
    input.headroomMs,
  ].reduce((total, duration) => total + duration, 0);
}

function defaultIdentityStageBudget(env: NodeJS.ProcessEnv = process.env): IdentityStageBudgetInput {
  const brandFitCriticMs = effectiveCriticDeadlineMs(env, 'brand-fit-critic', identityDefaultCriticMs);
  const divergenceCriticMs = effectiveCriticDeadlineMs(env, 'divergence-critic', identityDefaultCriticMs);
  const accessibilityCriticMs = effectiveCriticDeadlineMs(env, 'system-a11y-critic', identityDefaultAccessibilityCriticMs);
  return {
    curatorMs: identityCuratorMs,
    directorMs: identityDirectorMs,
    initialCriticMs: [
      ...repeated(brandFitCriticMs, identityDirections),
      divergenceCriticMs,
      ...repeated(accessibilityCriticMs, identityDirections),
    ],
    refinerMs: identityRefinerMs,
    secondCriticMs: [
      ...repeated(brandFitCriticMs, identityDirections),
      ...repeated(accessibilityCriticMs, identityDirections),
    ],
    artDirectorMs: identityArtDirectorMs,
    directionCount: identityDirections,
    maxActiveClaude: DEFAULT_MAX_ACTIVE_CLAUDE,
    correctiveAttempts: 1,
    headroomMs: identityHeadroomMs,
  };
}

export const stageDeadlinesMs: Record<AgentTask['stage'], number> = {
  get identity() { return calculateIdentityStageDeadlineMs(defaultIdentityStageBudget()); },
  prototype: 15 * 60_000,
  finalization: 20 * 60_000,
};

function valueAt(ir: DesignIR, path: string): unknown {
  let current: unknown = ir;
  for (const segment of path.split('/').slice(1)) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export class RunPlanner {
  /** `modelAlias` is what the resolved provider is called on every task; `idempotencyKey` hashes it. */
  constructor(private readonly store: VersionStore, private readonly modelAlias: string = 'claude-local') {}

  plan(runId: string, baseVersionId: string, brief: string): RunPlan {
    const base = this.store.get(baseVersionId);
    if (!base) throw new Error(`Cannot plan run ${runId}; version ${baseVersionId} is not in the store.`);
    const documentSlice: Record<string, unknown> = { '/identity': base.ir.identity };
    for (const path of readablePaths) documentSlice[path] = valueAt(base.ir, path);
    const override = Number(process.env.PWB_STAGE_DEADLINE_MS);
    const deadline = (stage: AgentTask['stage']): number => Number.isFinite(override) && override > 0 ? override : stageDeadlinesMs[stage];
    const stages: Array<{ stage: AgentTask['stage']; deadlineMs: number }> = [
      { stage: 'identity', deadlineMs: deadline('identity') },
      { stage: 'prototype', deadlineMs: deadline('prototype') },
      { stage: 'finalization', deadlineMs: deadline('finalization') },
    ];
    const inputDigest = hashJson({ runId, brief, documentSlice });
    const tasks = stages.map((item) => ({ id: `task-${item.stage}`, ...item, role: stageRoles[item.stage], attempt: 1, state: 'queued' as const, lane: 'claude' as const, baseVersionId, inputDigest, promptVersion: 'phase0-v1', modelAlias: this.modelAlias, allowedPaths: stageWritablePaths[item.stage], documentSlice, brief }));
    return { runId, tasks, edges: [['task-identity', 'task-prototype'], ['task-prototype', 'task-finalization']] };
  }
}
