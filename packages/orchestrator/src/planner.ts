import { hashJson, type AgentTask, type DesignIR } from '@pwb/domain';
import type { VersionStore } from './applier.js';

export interface RunPlan { runId: string; tasks: AgentTask[]; }

const allowedPaths = ['/identity', '/pages', '/assets', '/reviewRecord'];

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
    for (const path of allowedPaths) documentSlice[path] = valueAt(base.ir, path);
    const stages: Array<{ stage: AgentTask['stage']; role: AgentTask['role']; deadlineMs: number }> = [
      { stage: 'identity', role: 'director', deadlineMs: 5 * 60_000 },
      { stage: 'prototype', role: 'composer', deadlineMs: 5 * 60_000 },
      { stage: 'finalization', role: 'compiler', deadlineMs: 8 * 60_000 },
    ];
    const inputDigest = hashJson({ runId, brief, documentSlice });
    const tasks = stages.map((item) => ({ id: `task-${item.stage}`, ...item, attempt: 1, state: 'queued' as const, lane: 'claude' as const, baseVersionId, inputDigest, promptVersion: 'phase0-v1', modelAlias: 'claude-local', allowedPaths, documentSlice, brief }));
    return { runId, tasks };
  }
}
