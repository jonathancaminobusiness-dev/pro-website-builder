import { hashJson, stageRoles, stageWritablePaths, type AgentTask, type DesignIR } from '@pwb/domain';
import type { VersionStore } from './applier.js';

export interface RunPlan { runId: string; tasks: AgentTask[]; edges: [string, string][]; }

const readablePaths = ['/identity', '/pages', '/assets', '/reviewRecord'];

// Identity has a serial refinement and a second critic read after the initial
// fan-out. Its stage budget must cover that critical path after the
// accessibility critics' ten-minute default, while each worker still keeps its
// own deadline for fail-fast recovery.
export const stageDeadlinesMs: Record<AgentTask['stage'], number> = { identity: 45 * 60_000, prototype: 15 * 60_000, finalization: 20 * 60_000 };

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
