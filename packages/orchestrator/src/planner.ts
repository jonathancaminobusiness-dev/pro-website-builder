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
const identityCorrectedMs = (deadlineMs: number): number => deadlineMs * 2;

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

function claudeLaneDurationMs(durations: number[]): number {
  const laneEndTimes = Array.from({ length: DEFAULT_MAX_ACTIVE_CLAUDE }, () => 0);
  for (const duration of durations) {
    const lane = laneEndTimes.indexOf(Math.min(...laneEndTimes));
    laneEndTimes[lane]! += duration;
  }
  return Math.max(...laneEndTimes);
}

export function identityStageDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const brandFitCriticMs = effectiveCriticDeadlineMs(env, 'brand-fit-critic', identityDefaultCriticMs);
  const divergenceCriticMs = effectiveCriticDeadlineMs(env, 'divergence-critic', identityDefaultCriticMs);
  const accessibilityCriticMs = effectiveCriticDeadlineMs(env, 'system-a11y-critic', identityDefaultAccessibilityCriticMs);
  const initialCriticMs = claudeLaneDurationMs([
    ...repeated(identityCorrectedMs(brandFitCriticMs), identityDirections),
    identityCorrectedMs(divergenceCriticMs),
    ...repeated(identityCorrectedMs(accessibilityCriticMs), identityDirections),
  ]);
  const secondCriticMs = claudeLaneDurationMs([
    ...repeated(identityCorrectedMs(brandFitCriticMs), identityDirections),
    ...repeated(identityCorrectedMs(accessibilityCriticMs), identityDirections),
  ]);
  return [
    identityCorrectedMs(identityCuratorMs),
    claudeLaneDurationMs(repeated(identityCorrectedMs(identityDirectorMs), identityDirections)),
    initialCriticMs,
    identityDirections * identityRefinerMs,
    secondCriticMs,
    claudeLaneDurationMs(repeated(identityCorrectedMs(identityArtDirectorMs), identityDirections)),
    identityHeadroomMs,
  ].reduce((total, duration) => total + duration, 0);
}

export const stageDeadlinesMs: Record<AgentTask['stage'], number> = {
  get identity() { return identityStageDeadlineMs(); },
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
  constructor(private readonly store: VersionStore) {}

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
    const tasks = stages.map((item) => ({ id: `task-${item.stage}`, ...item, role: stageRoles[item.stage], attempt: 1, state: 'queued' as const, lane: 'claude' as const, baseVersionId, inputDigest, promptVersion: 'phase0-v1', modelAlias: 'claude-local', allowedPaths: stageWritablePaths[item.stage], documentSlice, brief }));
    return { runId, tasks, edges: [['task-identity', 'task-prototype'], ['task-prototype', 'task-finalization']] };
  }
}
